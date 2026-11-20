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

func serve(writable, hostReplacements bool) error {
	root, err := unix.Open("/backing", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
	if err != nil {
		return err
	}
	defer unix.Close(root)
	workspace := &backing{root: root, staging: root, writable: writable, replace: func(stage, target string, previous unix.Stat_t) error {
		return unix.Renameat(root, stage, root, target)
	}}
	if hostReplacements {
		staging, err := unix.Open("/staging", unix.O_PATH|unix.O_DIRECTORY|unix.O_CLOEXEC, 0)
		if err != nil {
			return err
		}
		defer unix.Close(staging)
		replacer, err := net.ListenUnix("unix", &net.UnixAddr{Name: replacementSocket, Net: "unix"})
		if err != nil {
			return err
		}
		defer replacer.Close()
		if err := os.Chmod(replacementSocket, 0600); err != nil {
			return err
		}
		workspace.staging = staging
		workspace.replace = (&hostReplacer{listener: replacer, root: root}).replace
	}
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
		if err != nil {
			log.Print(err)
		}
		conn.Close()
	}
}

func attach(c *net.UnixConn, workspace *backing) error {
	socket, err := c.SyscallConn()
	if err != nil {
		return err
	}
	var cred *unix.Ucred
	var peerErr error
	if err = socket.Control(func(fd uintptr) {
		cred, peerErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return err
	}
	if peerErr != nil {
		return peerErr
	}
	if cred.Uid != 0 {
		return fmt.Errorf("mount request from uid %d: %w", cred.Uid, unix.EACCES)
	}
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
	// Leave entry and attribute caching disabled so a new lookup sees host replacements.
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

func mount(writable, launcher bool) error {
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
	if launcher {
		args = []string{"setpriv", "--clear-groups", "--no-new-privs", "--bounding-set=-all,+setuid,+setgid", "--inh-caps=-all", "--ambient-caps=-all", "--"}
	}
	return unix.Exec("/usr/bin/setpriv", append(args, os.Args[3:]...), os.Environ())
}

func waitWorker() error {
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		var stat unix.Statfs_t
		command, err := os.ReadFile("/proc/1/comm")
		if err != nil {
			return err
		}
		if string(command) == "sleep\n" && unix.Statfs("/workspace", &stat) == nil && stat.Type == unix.FUSE_SUPER_MAGIC {
			return nil
		}
		time.Sleep(10 * time.Millisecond)
	}
	return unix.ETIMEDOUT
}

func main() {
	var err error
	switch {
	case len(os.Args) == 3 && os.Args[1] == "serve":
		log.SetOutput(os.Stdout)
		err = serve(os.Args[2] == "read-write", false)
	case len(os.Args) == 2 && os.Args[1] == "serve-host":
		log.SetOutput(os.Stdout)
		err = serve(true, true)
	case len(os.Args) == 2 && os.Args[1] == "host-channel":
		err = hostChannel()
	case len(os.Args) > 3 && (os.Args[1] == "mount" || os.Args[1] == "mount-launcher"):
		err = mount(os.Args[2] == "read-write", os.Args[1] == "mount-launcher")
	case len(os.Args) == 2 && os.Args[1] == "wait-worker":
		err = waitWorker()
	default:
		log.Fatal("expected serve or mount with a workload command")
	}
	if err != nil {
		log.Fatal(err)
	}
}
