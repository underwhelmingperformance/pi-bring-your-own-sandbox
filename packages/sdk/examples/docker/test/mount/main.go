//go:build linux

package main

import (
	"context"
	"fmt"
	"log"
	"net"
	"os"
	"syscall"
	"time"

	"github.com/hanwen/go-fuse/v2/fs"
	"github.com/hanwen/go-fuse/v2/fuse"
	"golang.org/x/sys/unix"
)

// The probe exposes one synthetic file. The service only needs the device
// descriptor for the mount in the other container.
type fixture struct{ fs.Inode }

func (root *fixture) Lookup(ctx context.Context, name string, out *fuse.EntryOut) (*fs.Inode, syscall.Errno) {
	if name != "probe" {
		return nil, syscall.ENOENT
	}
	return root.NewInode(ctx, &fs.MemRegularFile{Data: []byte("mediated\n"), Attr: fuse.Attr{Mode: syscall.S_IFREG | 0444}}, fs.StableAttr{Mode: syscall.S_IFREG}), 0
}

func serve() error {
	listener, err := net.ListenUnix("unixpacket", &net.UnixAddr{Name: "/control/service", Net: "unixpacket"})
	if err != nil {
		return err
	}
	defer listener.Close()
	if err = os.Chmod("/control/service", 0600); err != nil {
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
		err = attach(conn)
		conn.Close()
		if err != nil {
			log.Print(err)
		}
	}
}
func attach(c *net.UnixConn) error {
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
	if n != 1 || b[0] != 1 || flags&unix.MSG_CTRUNC != 0 || len(messages) != 1 {
		return fmt.Errorf("invalid mount request")
	}
	fds, err := unix.ParseUnixRights(&messages[0])
	if err != nil {
		return err
	}
	if len(fds) != 1 {
		for _, fd := range fds {
			unix.Close(fd)
		}
		return fmt.Errorf("expected one descriptor")
	}
	opts := &fs.Options{MountOptions: fuse.MountOptions{Name: "byos", DisableXAttrs: true}}
	raw := fs.NewNodeFS(&fixture{}, opts)
	server, err := fuse.NewServer(raw, fmt.Sprintf("/dev/fd/%d", fds[0]), &opts.MountOptions)
	if err != nil {
		unix.Close(fds[0])
		return err
	}
	go server.Serve()
	if err := server.WaitMount(); err != nil {
		return err
	}
	_, err = c.Write([]byte{1})
	return err
}
func mount() error {
	fd, err := unix.Open("/dev/fuse", unix.O_RDWR|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	opts := fmt.Sprintf("fd=%d,rootmode=40000,user_id=0,group_id=0,allow_other,default_permissions", fd)
	if err := unix.Mount("byos", "/workspace", "fuse", unix.MS_NOSUID|unix.MS_NODEV, opts); err != nil {
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
	return unix.Exec("/usr/bin/setpriv", append(args, os.Args[2:]...), os.Environ())
}
func main() {
	var err error
	switch {
	case len(os.Args) == 2 && os.Args[1] == "serve":
		err = serve()
	case len(os.Args) > 2 && os.Args[1] == "mount":
		err = mount()
	default:
		log.Fatal("expected serve or mount with a workload command")
	}
	if err != nil {
		log.Fatal(err)
	}
}
