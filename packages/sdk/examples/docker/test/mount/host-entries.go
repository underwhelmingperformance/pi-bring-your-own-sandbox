//go:build linux

package main

import (
	"context"
	"path"
	"strings"
	"syscall"
	"time"
	"unicode/utf8"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

func (b *backing) writablePath(relative string) bool {
	if b.host == nil {
		return writableRootFile(relative)
	}
	for _, part := range strings.Split(relative, "/") {
		if part == "" || part == "." || part == ".." || !utf8.ValidString(part) || strings.HasPrefix(part, stagePrefix) {
			return false
		}
	}
	return true
}

// A host-created name may be absent from the VM's directory cache until it expires.
func (b *backing) openCreated(relative, expected string) (int, error) {
	node := &workspaceNode{backing: b, relative: relative}
	deadline := time.Now().Add(2 * time.Second)
	for {
		fd, errno := node.open(unix.S_IFREG, unix.O_RDONLY)
		if errno == 0 {
			var st unix.Stat_t
			if err := unix.Fstat(fd, &st); err != nil {
				unix.Close(fd)
				return -1, err
			}
			current, err := b.host.version(hostChange{Op: "identify", Target: relative}, st)
			if err != nil || current != expected {
				unix.Close(fd)
				if err != nil {
					return -1, err
				}
				return -1, unix.ESTALE
			}
			return fd, nil
		}
		if errno != unix.ENOENT || time.Now().After(deadline) {
			return -1, errno
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (n *workspaceNode) remove(name, operation string) syscall.Errno {
	if n.host == nil || !n.writable {
		return n.removalError()
	}
	target := path.Join(n.relative, name)
	if !n.writablePath(target) {
		return unix.EACCES
	}
	n.mutations.Lock()
	defer n.mutations.Unlock()
	fd, _, errno := n.pin()
	if errno != 0 {
		return errno
	}
	unix.Close(fd)
	previous, err := entryStat(n.root, target)
	if err != nil {
		return fs.ToErrno(err)
	}
	if err := n.host.change(hostChange{Op: operation, Target: target}); err != nil {
		return fs.ToErrno(err)
	}
	n.host.waitForEntry(target, previous)
	return 0
}

func (n *workspaceNode) Mkdir(ctx context.Context, name string, mode uint32, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if n.host == nil || !n.writable {
		return nil, n.removalError()
	}
	target := path.Join(n.relative, name)
	if !n.writablePath(target) {
		return nil, unix.EACCES
	}
	n.mutations.Lock()
	defer n.mutations.Unlock()
	fd, _, errno := n.pin()
	if errno != 0 {
		return nil, errno
	}
	unix.Close(fd)
	if err := n.host.change(hostChange{Op: "mkdir", Target: target, Mode: mode & 0777}); err != nil {
		return nil, fs.ToErrno(err)
	}
	deadline := time.Now().Add(2 * time.Second)
	for {
		child, errno := n.Lookup(ctx, name, out)
		if errno != unix.ENOENT || time.Now().After(deadline) {
			return child, errno
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (n *workspaceNode) Rename(ctx context.Context, name string, newParent fs.InodeEmbedder, newName string, flags uint32) syscall.Errno {
	if n.host == nil || !n.writable {
		return n.removalError()
	}
	parent, ok := newParent.(*workspaceNode)
	if !ok || parent.backing != n.backing {
		return unix.EXDEV
	}
	if flags != 0 {
		return unix.EINVAL
	}
	source, target := path.Join(n.relative, name), path.Join(parent.relative, newName)
	if !n.writablePath(source) || !n.writablePath(target) {
		return unix.EACCES
	}
	n.mutations.Lock()
	defer n.mutations.Unlock()
	for _, directory := range []*workspaceNode{n, parent} {
		fd, _, errno := directory.pin()
		if errno != 0 {
			return errno
		}
		unix.Close(fd)
	}
	before, err := entryStat(n.root, source)
	if err != nil {
		return fs.ToErrno(err)
	}
	destination, err := entryStat(n.root, target)
	if err != nil && err != unix.ENOENT {
		return fs.ToErrno(err)
	}
	operation := "rename"
	if before.Mode&unix.S_IFMT == unix.S_IFREG {
		operation = "rename-file"
	}
	if err := n.host.change(hostChange{Op: operation, Source: source, Target: target}); err != nil {
		return fs.ToErrno(err)
	}
	if before.Dev == destination.Dev && before.Ino == destination.Ino {
		return 0
	}
	n.host.waitForEntry(source, before)
	n.host.waitForEntry(target, destination)
	return 0
}
