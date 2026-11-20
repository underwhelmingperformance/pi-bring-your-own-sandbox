//go:build linux

package main

import (
	"fmt"
	"log"
	"net"
	"os"

	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

func serve(writable bool) error {
	root, err := unix.Open("/backing", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(root)
	workspace := &backing{root: root, writable: writable}
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: "/control/service", Net: "unixpacket"})
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Chmod("/control/service", 0666); err != nil {
		return err
	}
	for {
		conn, err := listener.AcceptUnix()
		if err != nil {
			return err
		}
		if err = conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			conn.Close()
			return err
		}
		err = attach(conn, workspace)
		conn.Close()
		if err != nil {
			log.Print(err)
		}
	}
}

func attach(c *net.UnixConn, workspace *backing) error {
	var b [1]byte
	control := make([]byte, unix.CmsgSpace(4))
	n, size, flags, _, err := c.ReadMsgUnix(b[:], control)
	if err != nil {
		return err
	}
	messages, err := unix.ParseSocketControlMessage(control[:size])
	if err != nil {
		return err
	}
	var fds []int
	for _, message := range messages {
		if message.Header.Level == unix.SOL_SOCKET && message.Header.Type == unix.SCM_RIGHTS {
			rights, err := unix.ParseUnixRights(&message)
			if err != nil {
				for _, fd := range fds {
					unix.Close(fd)
				}
				return err
			}
			fds = append(fds, rights...)
		}
	}
	if n != 1 || b[0] != 1 || flags&(unix.MSG_CTRUNC|unix.MSG_TRUNC) != 0 || len(messages) != 1 || len(fds) != 1 {
		for _, fd := range fds {
			unix.Close(fd)
		}
		return fmt.Errorf("invalid mount request")
	}
	opts := &fs.Options{MountOptions: fuse.MountOptions{Name: "byos", DisableXAttrs: true, ExtraCapabilities: fuse.CAP_ATOMIC_O_TRUNC}}
	raw := fs.NewNodeFS(&workspaceNode{backing: workspace, relative: "."}, opts)
	server, err := fuse.NewServer(raw, fmt.Sprintf("/dev/fd/%d", fds[0]), &opts.MountOptions)
	if err != nil {
		return err
	}
	go server.Serve()
	_, err = c.Write([]byte{1})
	return err
}

func mount(writable bool) error {
	fd, err := unix.Open("/dev/fuse", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	opts := fmt.Sprintf("fd=%d,rootmode=40000,user_id=0,group_id=0,allow_other,default_permissions", fd)
	flags := uintptr(unix.MS_NOSUID | unix.MS_NODEV)
	if !writable {
		flags |= unix.MS_RDONLY
	}
	if err := unix.Mount("byos", "/workspace", "fuse", flags, opts); err != nil {
		return err
	}
	conn, err := net.DialUnix("unixpacket", nil, &net.UnixAddr{Name: "/control/service", Net: "unixpacket"})
	if err != nil {
		return err
	}
	if _, _, err = conn.WriteMsgUnix([]byte{1}, unix.UnixRights(fd), nil); err != nil {
		return err
	}
	if err = unix.Close(fd); err != nil {
		return err
	}
	if err = conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	var b [1]byte
	if _, err = conn.Read(b[:]); err != nil {
		return err
	}
	if b[0] != 1 {
		return fmt.Errorf("mount service refused the request")
	}
	conn.Close()
	if err = unix.Unmount("/control", unix.MNT_DETACH); err != nil {
		return err
	}
	if err = unix.Unlink("/dev/fuse"); err != nil {
		return err
	}
	args := []string{"setpriv", "--reuid=65534", "--regid=65534", "--clear-groups", "--no-new-privs", "--bounding-set=-all", "--inh-caps=-all", "--ambient-caps=-all", "--"}
	return unix.Exec("/usr/bin/setpriv", append(args, os.Args[3:]...), os.Environ())
}

func main() {
	var err error
	switch {
	case len(os.Args) == 3 && os.Args[1] == "serve":
		log.SetOutput(os.Stdout)
		err = serve(os.Args[2] == "read-write")
	case len(os.Args) > 3 && os.Args[1] == "mount":
		err = mount(os.Args[2] == "read-write")
	default:
		log.Fatal("expected serve or mount with a workload command")
	}
	if err != nil {
		log.Fatal(err)
	}
}
