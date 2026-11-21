//go:build linux

package main

import (
	"context"
	"fmt"
	"path"
	"strings"
	"sync"
	"syscall"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

type backing struct {
	root      int
	staging   int
	host      *hostReplacer
	writable  bool
	mutations sync.Mutex
	created   int
}

type workspaceNode struct {
	fs.Inode
	*backing
	relative string
	inode    uint64
}

func (n *workspaceNode) pin() (int, syscall.Stat_t, syscall.Errno) {
	var stat syscall.Stat_t
	fd, err := unix.Openat2(n.root, n.relative, &unix.OpenHow{
		Flags:   unix.O_PATH | unix.O_NOFOLLOW | unix.O_CLOEXEC,
		Resolve: unix.RESOLVE_BENEATH | unix.RESOLVE_NO_SYMLINKS | unix.RESOLVE_NO_XDEV,
	})
	if err != nil {
		return -1, stat, fs.ToErrno(err)
	}
	if err := syscall.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return -1, stat, fs.ToErrno(err)
	}
	if n.inode != 0 && n.inode != stat.Ino {
		unix.Close(fd)
		return -1, stat, syscall.ESTALE
	}
	switch stat.Mode & syscall.S_IFMT {
	case syscall.S_IFDIR:
	case syscall.S_IFREG, syscall.S_IFLNK:
		if stat.Nlink != 1 {
			unix.Close(fd)
			return -1, stat, syscall.EACCES
		}
	default:
		unix.Close(fd)
		return -1, stat, syscall.EACCES
	}
	return fd, stat, 0
}

func (n *workspaceNode) attributes(stat *syscall.Stat_t, attr *fuse.Attr) {
	attr.FromStat(stat)
	attr.Uid, attr.Gid = 65534, 65534
	attr.Mode &^= 07000
	if !n.writable {
		attr.Mode &^= 0222
	}
}

func (n *workspaceNode) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if strings.HasPrefix(name, stagePrefix) {
		return nil, syscall.ENOENT
	}
	if name == "" || name == "." || name == ".." || strings.ContainsRune(name, '/') {
		return nil, syscall.EINVAL
	}
	if errno := n.checkPath(); errno != 0 {
		return nil, errno
	}
	child := &workspaceNode{backing: n.backing, relative: path.Join(n.relative, name)}
	fd, stat, errno := child.pin()
	if errno != 0 {
		return nil, errno
	}
	unix.Close(fd)
	if errno := n.checkPath(); errno != 0 {
		return nil, errno
	}
	child.inode = stat.Ino
	n.attributes(&stat, &out.Attr)
	// Linux can request attributes without a file handle. go-fuse then uses the
	// inode's first open handle. Separate lookups need separate inodes because
	// a staged write replaces the file while earlier readers still have it open.
	return n.NewInode(ctx, child, fs.StableAttr{Mode: stat.Mode & syscall.S_IFMT}), 0
}

func (n *workspaceNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	var stat syscall.Stat_t
	switch handle := f.(type) {
	case *reader:
		stat = handle.opened
		if fd, current, errno := handle.node.pin(); errno == 0 {
			unix.Close(fd)
			stat = current
		}
	case *workspaceWriter:
		handle.mu.Lock()
		defer handle.mu.Unlock()
		stat = handle.attributes
	default:
		fd, pinned, errno := n.pin()
		if errno != 0 {
			return errno
		}
		unix.Close(fd)
		stat = pinned
	}
	n.attributes(&stat, &out.Attr)
	return 0
}

func (n *workspaceNode) open(kind uint32, flags int) (int, syscall.Errno) {
	fd, stat, errno := n.pin()
	if errno != 0 {
		return -1, errno
	}
	defer unix.Close(fd)
	if stat.Mode&syscall.S_IFMT != kind {
		return -1, syscall.ESTALE
	}
	// Reopen the checked inode. Opening its workspace path again could select a FIFO or device.
	opened, err := unix.Open(fmt.Sprintf("/proc/self/fd/%d", fd), flags|unix.O_CLOEXEC, 0)
	return opened, fs.ToErrno(err)
}

type workspaceDir struct {
	entries fs.DirStream
	node    *workspaceNode
}

func (n *workspaceNode) checkPath() syscall.Errno {
	fd, _, errno := n.pin()
	if errno == 0 {
		unix.Close(fd)
	}
	return errno
}

func (n *workspaceNode) OpendirHandle(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	fd, errno := n.open(syscall.S_IFDIR, unix.O_RDONLY|unix.O_DIRECTORY)
	if errno != 0 {
		return nil, 0, errno
	}
	entries, errno := fs.NewLoopbackDirStreamFd(fd)
	if errno != 0 {
		unix.Close(fd)
		return nil, 0, errno
	}
	return &workspaceDir{entries, n}, 0, 0
}

func (d *workspaceDir) Readdirent(ctx context.Context) (*fuse.DirEntry, syscall.Errno) {
	if errno := d.node.checkPath(); errno != 0 {
		return nil, errno
	}
	for d.entries.HasNext() {
		entry, errno := d.entries.Next()
		if errno != 0 {
			return nil, errno
		}
		if !strings.HasPrefix(entry.Name, stagePrefix) {
			if errno := d.node.checkPath(); errno != 0 {
				return nil, errno
			}
			return &entry, 0
		}
	}
	return nil, 0
}

func (d *workspaceDir) Seekdir(ctx context.Context, off uint64) syscall.Errno {
	if seeker, ok := d.entries.(fs.FileSeekdirer); ok {
		return seeker.Seekdir(ctx, off)
	}
	return syscall.ENOTSUP
}

func (d *workspaceDir) Releasedir(ctx context.Context, flags uint32) { d.entries.Close() }

func (n *workspaceNode) Readlink(ctx context.Context) ([]byte, syscall.Errno) {
	fd, _, errno := n.pin()
	if errno != 0 {
		return nil, errno
	}
	defer unix.Close(fd)
	target := make([]byte, 4096)
	count, err := unix.Readlinkat(fd, "", target)
	if err != nil {
		return nil, fs.ToErrno(err)
	}
	if count == len(target) {
		return nil, syscall.ENAMETOOLONG
	}
	if errno := n.checkPath(); errno != 0 {
		return nil, errno
	}
	return target[:count], 0
}

type reader struct {
	fd     int
	node   *workspaceNode
	opened syscall.Stat_t
}

func (n *workspaceNode) reader(fd int) (*reader, syscall.Errno) {
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return nil, fs.ToErrno(err)
	}
	return &reader{fd, n, stat}, 0
}

func (n *workspaceNode) Open(ctx context.Context, flags uint32) (fs.FileHandle, uint32, syscall.Errno) {
	if flags&(unix.O_ACCMODE|unix.O_TRUNC) != unix.O_RDONLY {
		if !n.writable {
			return nil, 0, syscall.EROFS
		}
		return n.openWriter(flags)
	}
	fd, errno := n.open(syscall.S_IFREG, unix.O_RDONLY)
	if errno != 0 {
		return nil, 0, errno
	}
	handle, errno := n.reader(fd)
	return handle, fuse.FOPEN_DIRECT_IO, errno
}

func (f *reader) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	return readCurrent(f.node.root, f.node.relative, f.fd, dest, off)
}

func currentReadEntry(root int, relative string, fd int) (unix.Stat_t, syscall.Errno) {
	entry, err := entryStat(root, relative)
	if err == unix.ENOENT {
		return entry, unix.ESTALE
	}
	if err != nil {
		return entry, fs.ToErrno(err)
	}
	var opened unix.Stat_t
	if err := unix.Fstat(fd, &opened); err != nil {
		return entry, fs.ToErrno(err)
	}
	if entry.Dev != opened.Dev || entry.Ino != opened.Ino {
		return entry, unix.ESTALE
	}
	if entry.Nlink != 1 || opened.Nlink != 1 {
		return entry, unix.EACCES
	}
	if entry.Ctim != opened.Ctim || entry.Size != opened.Size {
		return entry, unix.ESTALE
	}
	return opened, 0
}

func readCurrent(root int, relative string, fd int, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	before, errno := currentReadEntry(root, relative, fd)
	if errno != 0 {
		return nil, errno
	}
	n, err := unix.Pread(fd, dest, off)
	if err != nil {
		return nil, fs.ToErrno(err)
	}
	after, errno := currentReadEntry(root, relative, fd)
	if errno != 0 {
		return nil, errno
	}
	if before.Ctim != after.Ctim || before.Size != after.Size {
		return nil, unix.ESTALE
	}
	return fuse.ReadResultData(dest[:n]), 0
}

func (f *reader) Release(ctx context.Context) syscall.Errno {
	return fs.ToErrno(unix.Close(f.fd))
}
