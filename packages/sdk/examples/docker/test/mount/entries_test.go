//go:build linux

package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
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

func TestCreateOpensTheFileAcknowledgedByTheHost(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "new"), nil, 0600); err != nil {
		t.Fatal(err)
	}
	fd, err := unix.Open(root, unix.O_PATH|unix.O_DIRECTORY, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer unix.Close(fd)
	for _, test := range []struct {
		name    string
		current string
		want    error
	}{{"created file", "created", nil}, {"replaced file", "replacement", unix.ESTALE}} {
		t.Run(test.name, func(t *testing.T) {
			replies := strings.NewReader(`{"Status":"OK","Identity":"created"}` + "\n" + `{"Status":"OK","Identity":"` + test.current + `"}`)
			host := &hostReplacer{root: fd, replies: json.NewDecoder(replies)}
			node := &workspaceNode{backing: &backing{root: fd, host: host, writable: true}, relative: "."}
			opened, _, err := node.create("new", 0600)
			if opened >= 0 {
				defer unix.Close(opened)
			}
			if err != test.want {
				t.Fatalf("create returned %v, want %v", err, test.want)
			}
		})
	}
}
