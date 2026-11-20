//go:build linux

package main

import (
	"bytes"
	"context"
	"fmt"
	"io"
	"os"
	"path"
	"strings"
	"sync"
	"syscall"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

const maxWriteSize = 16 << 20
const stagePrefix = ".pi-byos-write-"

type workspaceWriter struct {
	mu   sync.Mutex
	file *os.File
	*backing
	name string
}

func (n *workspaceNode) openWriter(flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if path.Base(n.relative) != n.relative || strings.HasPrefix(n.relative, ".") {
		return nil, 0, syscall.EACCES
	}
	fd, errno := n.open(unix.S_IFREG, unix.O_RDWR)
	if errno != 0 {
		return nil, 0, errno
	}
	w := &workspaceWriter{file: os.NewFile(uintptr(fd), n.relative), backing: n.backing, name: n.relative}
	if flags&unix.O_TRUNC != 0 {
		if err := w.replace(nil, 0, true); err != nil {
			w.file.Close()
			return nil, 0, fs.ToErrno(err)
		}
	}
	return w, fuse.FOPEN_DIRECT_IO, 0
}

func (w *workspaceWriter) replace(data []byte, offset int64, truncate bool) error {
	w.mutations.Lock()
	defer w.mutations.Unlock()
	var source unix.Stat_t
	if err := unix.Fstat(int(w.file.Fd()), &source); err != nil {
		return err
	}
	if source.Nlink != 1 || source.Mode&07000 != 0 || int(source.Uid) != os.Geteuid() || int(source.Gid) != os.Getegid() {
		return unix.EACCES
	}
	if offset < 0 || offset > maxWriteSize-int64(len(data)) || source.Size > maxWriteSize {
		return unix.EFBIG
	}

	staged, err := os.CreateTemp(fmt.Sprintf("/proc/self/fd/%d", w.root), stagePrefix)
	if err != nil {
		return err
	}
	stage := path.Base(staged.Name())
	published := false
	defer func() {
		if !published {
			staged.Close()
			unix.Unlinkat(w.root, stage, 0)
		}
	}()
	if !truncate {
		if _, err := io.CopyN(staged, io.NewSectionReader(w.file, 0, source.Size), source.Size); err != nil {
			return err
		}
	}
	if len(data) > 0 {
		if _, err := staged.WriteAt(data, offset); err != nil {
			return err
		}
	}
	if err := staged.Chmod(os.FileMode(source.Mode & 0777)); err != nil {
		return err
	}
	if err := preserveAttributes(int(w.file.Fd()), int(staged.Fd())); err != nil {
		return err
	}
	var current unix.Stat_t
	if err := unix.Fstatat(w.root, w.name, &current, unix.AT_SYMLINK_NOFOLLOW); err != nil {
		return err
	}
	if current.Ino != source.Ino || current.Dev != source.Dev || current.Ctim != source.Ctim || current.Nlink != 1 {
		return unix.ESTALE
	}
	if err := unix.Renameat(w.root, stage, w.root, w.name); err != nil {
		return err
	}
	published = true
	previous := w.file
	w.file = staged
	return previous.Close()
}

func (w *workspaceWriter) Write(ctx context.Context, data []byte, off int64) (uint32, syscall.Errno) {
	w.mu.Lock()
	defer w.mu.Unlock()
	if err := w.replace(data, off, false); err != nil {
		return 0, fs.ToErrno(err)
	}
	return uint32(len(data)), 0
}

func (w *workspaceWriter) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	w.mu.Lock()
	defer w.mu.Unlock()
	n, err := w.file.ReadAt(dest, off)
	if err != nil && err != io.EOF {
		return nil, fs.ToErrno(err)
	}
	return fuse.ReadResultData(dest[:n]), 0
}

func (w *workspaceWriter) Release(ctx context.Context) syscall.Errno {
	w.mu.Lock()
	defer w.mu.Unlock()
	return fs.ToErrno(w.file.Close())
}

func (w *workspaceWriter) Fsync(ctx context.Context, flags uint32) syscall.Errno {
	w.mu.Lock()
	defer w.mu.Unlock()
	return fs.ToErrno(w.file.Sync())
}

func listAttributes(fd int) (map[string][]byte, error) {
	size, err := unix.Flistxattr(fd, nil)
	if err != nil {
		return nil, err
	}
	if size > 65536 {
		return nil, unix.E2BIG
	}
	names := make([]byte, size)
	if size > 0 {
		n, err := unix.Flistxattr(fd, names)
		if err != nil {
			return nil, err
		}
		names = names[:n]
	}
	attrs := make(map[string][]byte)
	remaining := 1 << 20
	for _, name := range strings.Split(string(names), "\x00") {
		if name == "" {
			continue
		}
		size, err := unix.Fgetxattr(fd, name, nil)
		if err != nil {
			return nil, err
		}
		if size > remaining {
			return nil, unix.E2BIG
		}
		value := make([]byte, size)
		if size > 0 {
			n, err := unix.Fgetxattr(fd, name, value)
			if err != nil {
				return nil, err
			}
			value = value[:n]
		}
		remaining -= len(value)
		attrs[name] = value
	}
	return attrs, nil
}

func preserveAttributes(source, target int) error {
	from, err := listAttributes(source)
	if err != nil {
		return err
	}
	to, err := listAttributes(target)
	if err != nil {
		return err
	}
	for name, value := range from {
		current, exists := to[name]
		delete(to, name)
		if exists && bytes.Equal(current, value) {
			continue
		}
		if strings.HasPrefix(name, "security.") || strings.HasPrefix(name, "system.") || strings.HasPrefix(name, "trusted.") {
			return unix.ENOTSUP
		}
		if err := unix.Fsetxattr(target, name, value, 0); err != nil {
			return err
		}
	}
	if len(to) > 0 {
		return unix.ENOTSUP
	}
	return nil
}
