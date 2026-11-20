//go:build linux

package main

import (
	"context"
	"os"
	"path/filepath"
	"syscall"
	"testing"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

func TestCreateWithExistingDirectory(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "existing"), 0700); err != nil {
		t.Fatal(err)
	}
	fd, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)

	node := &workspaceNode{backing: &backing{root: fd, writable: true}, relative: "."}
	fs.NewNodeFS(node, &fs.Options{})
	for _, access := range []uint32{unix.O_RDONLY, unix.O_WRONLY, unix.O_RDWR, unix.O_RDONLY | unix.O_TRUNC} {
		flags := uint32(unix.O_CREAT) | access
		inode, handle, fuseFlags, errno := node.Create(context.Background(), "existing", flags, 0600, &fuse.EntryOut{})
		if inode != nil || handle != nil || fuseFlags != 0 || errno != syscall.EISDIR {
			t.Errorf("create flags %#x returned (%v, %v, %#x, %v), want (nil, nil, 0, EISDIR)", flags, inode, handle, fuseFlags, errno)
		}
	}
}
