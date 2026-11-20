//go:build linux

package main

import (
	"encoding/json"
	"io"
	"net"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

const replacementSocket = "/control/replace"

type hostReplacer struct {
	root     int
	listener *net.UnixListener
	conn     net.Conn
	replies  *json.Decoder
}

func (p *hostReplacer) replace(stage, target string, previous unix.Stat_t) error {
	if p.conn == nil {
		if err := p.listener.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return err
		}
		conn, err := p.listener.AcceptUnix()
		if err != nil {
			return err
		}
		p.conn = conn
		p.replies = json.NewDecoder(conn)
		p.listener.Close()
	}
	if err := p.conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return err
	}
	if err := json.NewEncoder(p.conn).Encode([2]string{stage, target}); err != nil {
		p.conn.Close()
		return unix.EIO
	}
	var reply string
	if err := p.replies.Decode(&reply); err != nil {
		p.conn.Close()
		return unix.EIO
	}
	switch reply {
	case "OK":
		return p.waitForEntry(target, previous)
	case "EPERM", "EACCES":
		return unix.EACCES
	case "ENOENT":
		return unix.ESTALE
	default:
		return unix.EIO
	}
}

// The VM can cache the old directory entry after macOS has completed the rename.
func (p *hostReplacer) waitForEntry(target string, previous unix.Stat_t) error {
	deadline := time.Now().Add(2 * time.Second)
	for {
		var entry unix.Stat_t
		err := unix.Fstatat(p.root, target, &entry, unix.AT_SYMLINK_NOFOLLOW)
		if err == unix.ENOENT || (err == nil && (entry.Dev != previous.Dev || entry.Ino != previous.Ino)) {
			return nil
		}
		if err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return unix.ESTALE
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func hostChannel() error {
	conn, err := net.DialUnix("unix", nil, &net.UnixAddr{Name: replacementSocket, Net: "unix"})
	if err != nil {
		return err
	}
	defer conn.Close()
	go func() {
		io.Copy(conn, os.Stdin)
		conn.CloseWrite()
	}()
	_, err = io.Copy(os.Stdout, conn)
	return err
}
