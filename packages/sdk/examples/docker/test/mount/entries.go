//go:build linux

package main

import (
	"context"
	"path"
	"strings"
	"syscall"
	"unicode/utf8"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

func writableRootFile(name string) bool {
	return utf8.ValidString(name) && name != "" && !strings.HasPrefix(name, ".") && !strings.ContainsRune(name, '/')
}

const maxCreatedFiles = 16

// Without removal handlers go-fuse removes its cached child and reports success.
func (n *workspaceNode) removalError() syscall.Errno {
	if !n.writable {
		return syscall.EROFS
	}
	return syscall.ENOTSUP
}

func (n *workspaceNode) Unlink(ctx context.Context, name string) syscall.Errno {
	return n.remove(name, "unlink")
}

func (n *workspaceNode) Rmdir(ctx context.Context, name string) syscall.Errno {
	return n.remove(name, "rmdir")
}

func (n *workspaceNode) create(name string, mode uint32) (int, error) {
	b := n.backing
	b.mutations.Lock()
	defer b.mutations.Unlock()
	parent, _, errno := n.pin()
	if errno != 0 {
		return -1, errno
	}
	defer unix.Close(parent)
	if b.host != nil {
		if mode&0400 == 0 {
			return -1, unix.ENOTSUP
		}
		if err := b.host.change(hostChange{Op: "create", Target: name, Mode: mode & 0777}); err != nil {
			return -1, err
		}
		return b.openCreated(name)
	}
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
	relative := path.Join(n.relative, name)
	if !n.writablePath(relative) || mode&07000 != 0 {
		return nil, nil, 0, syscall.EACCES
	}
	fd, err := n.create(relative, mode)
	if err == unix.EEXIST && flags&unix.O_EXCL == 0 {
		inode, errno := n.Lookup(ctx, name, out)
		if errno != 0 {
			return nil, nil, 0, errno
		}
		if out.Attr.Mode&unix.S_IFMT == unix.S_IFDIR {
			return nil, nil, 0, syscall.EISDIR
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
	child := &workspaceNode{backing: n.backing, relative: relative, inode: stat.Ino}
	n.attributes(&stat, &out.Attr)
	inode := n.NewInode(ctx, child, fs.StableAttr{Mode: unix.S_IFREG})
	if flags&unix.O_ACCMODE == unix.O_RDONLY {
		handle, errno := child.reader(fd)
		return inode, handle, fuse.FOPEN_DIRECT_IO, errno
	}
	writer, err := child.writer(fd)
	if err != nil {
		return nil, nil, 0, fs.ToErrno(err)
	}
	return inode, writer, fuse.FOPEN_DIRECT_IO, 0
}
