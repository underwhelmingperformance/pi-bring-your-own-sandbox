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
	writable  bool
	mutations sync.Mutex
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
	child := &workspaceNode{backing: n.backing, relative: path.Join(n.relative, name)}
	fd, stat, errno := child.pin()
	if errno != 0 {
		return nil, errno
	}
	unix.Close(fd)
	child.inode = stat.Ino
	n.attributes(&stat, &out.Attr)
	return n.NewInode(ctx, child, fs.StableAttr{Mode: stat.Mode & syscall.S_IFMT}), 0
}

func (n *workspaceNode) Getattr(ctx context.Context, f fs.FileHandle, out *fuse.AttrOut) syscall.Errno {
	fd, stat, errno := n.pin()
	if errno != 0 {
		return errno
	}
	unix.Close(fd)
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

func (n *workspaceNode) Readdir(ctx context.Context) (fs.DirStream, syscall.Errno) {
	fd, errno := n.open(syscall.S_IFDIR, unix.O_RDONLY|unix.O_DIRECTORY)
	if errno != 0 {
		return nil, errno
	}
	return fs.NewLoopbackDirStreamFd(fd)
}

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
	return target[:count], 0
}

type reader struct{ fd int }

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
	return &reader{fd}, fuse.FOPEN_DIRECT_IO, 0
}

func (f *reader) Read(ctx context.Context, dest []byte, off int64) (fuse.ReadResult, syscall.Errno) {
	n, err := unix.Pread(f.fd, dest, off)
	if err != nil {
		return nil, fs.ToErrno(err)
	}
	return fuse.ReadResultData(dest[:n]), 0
}

func (f *reader) Release(ctx context.Context) syscall.Errno {
	return fs.ToErrno(unix.Close(f.fd))
}
