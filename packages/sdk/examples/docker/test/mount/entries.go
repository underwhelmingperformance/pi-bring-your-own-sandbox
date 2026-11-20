//go:build linux

package main

import (
	"context"
	"os"
	"strings"
	"syscall"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

func writableRootFile(name string) bool {
	return name != "" && !strings.HasPrefix(name, ".") && !strings.ContainsRune(name, '/')
}

const maxCreatedFiles = 16

// Without an Unlink handler go-fuse removes its cached child and reports success.
func (n *workspaceNode) Unlink(ctx context.Context, name string) syscall.Errno {
	if !n.writable {
		return syscall.EROFS
	}
	return syscall.ENOTSUP
}

func (b *backing) create(name string, mode uint32) (int, error) {
	b.mutations.Lock()
	defer b.mutations.Unlock()
	if b.created >= maxCreatedFiles {
		var stat unix.Stat_t
		err := unix.Fstatat(b.root, name, &stat, unix.AT_SYMLINK_NOFOLLOW)
		if err == nil {
			return -1, unix.EEXIST
		}
		if err != unix.ENOENT {
			return -1, err
		}
		return -1, unix.EDQUOT
	}
	fd, err := unix.Openat(b.root, name, unix.O_RDWR|unix.O_CREAT|unix.O_EXCL|unix.O_NOFOLLOW|unix.O_CLOEXEC, mode&0600)
	if err == nil {
		b.created++
	}
	return fd, err
}

func (n *workspaceNode) Create(ctx context.Context, name string, flags, mode uint32, out *fuse.EntryOut) (*fs.Inode, fs.FileHandle, uint32, syscall.Errno) {
	if !n.writable {
		return nil, nil, 0, syscall.EROFS
	}
	if n.relative != "." || !writableRootFile(name) || mode&07000 != 0 {
		return nil, nil, 0, syscall.EACCES
	}
	fd, err := n.create(name, mode)
	if err == unix.EEXIST && flags&unix.O_EXCL == 0 {
		inode, errno := n.Lookup(ctx, name, out)
		if errno != 0 {
			return nil, nil, 0, errno
		}
		child := inode.Operations().(*workspaceNode)
		handle, openFlags, errno := child.Open(ctx, flags)
		return inode, handle, openFlags, errno
	}
	if err != nil {
		return nil, nil, 0, fs.ToErrno(err)
	}
	var stat syscall.Stat_t
	if err := syscall.Fstat(fd, &stat); err != nil {
		unix.Close(fd)
		return nil, nil, 0, fs.ToErrno(err)
	}
	child := &workspaceNode{backing: n.backing, relative: name, inode: stat.Ino}
	n.attributes(&stat, &out.Attr)
	inode := n.NewInode(ctx, child, fs.StableAttr{Mode: unix.S_IFREG})
	if flags&unix.O_ACCMODE == unix.O_RDONLY {
		return inode, &reader{fd}, fuse.FOPEN_DIRECT_IO, 0
	}
	return inode, &workspaceWriter{file: os.NewFile(uintptr(fd), name), backing: n.backing, name: name}, fuse.FOPEN_DIRECT_IO, 0
}
