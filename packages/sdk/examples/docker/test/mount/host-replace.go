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

type hostChange struct {
	Op     string `json:"op"`
	Target string `json:"target"`
	Source string `json:"source,omitempty"`
	Mode   uint32 `json:"mode"`
}

func (p *hostReplacer) replace(stage, target string, previous unix.Stat_t) error {
	if err := p.change(hostChange{Op: "replace", Source: stage, Target: target}); err != nil {
		if err == unix.ENOENT {
			return unix.ESTALE
		}
		return err
	}
	return p.waitForEntry(target, previous)
}

func (p *hostReplacer) change(request hostChange) error {
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
	if err := json.NewEncoder(p.conn).Encode(request); err != nil {
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
		return nil
	case "EPERM", "EACCES":
		return unix.EACCES
	case "ENOENT":
		return unix.ENOENT
	case "EEXIST":
		return unix.EEXIST
	case "EISDIR":
		return unix.EISDIR
	case "ENOTDIR":
		return unix.ENOTDIR
	case "ENOTEMPTY":
		return unix.ENOTEMPTY
	case "EINVAL":
		return unix.EINVAL
	case "EXDEV":
		return unix.EXDEV
	case "EROFS":
		return unix.EROFS
	case "ENOSPC":
		return unix.ENOSPC
	case "EDQUOT":
		return unix.EDQUOT
	case "ENAMETOOLONG":
		return unix.ENAMETOOLONG
	default:
		return unix.EIO
	}
}

// The VM can cache the old directory entry after macOS has completed the rename.
func (p *hostReplacer) waitForEntry(target string, previous unix.Stat_t) error {
	deadline := time.Now().Add(2 * time.Second)
	for {
		entry, err := entryStat(p.root, target)
		if (err == unix.ENOENT && previous.Ino != 0) || (err == nil && (entry.Dev != previous.Dev || entry.Ino != previous.Ino)) {
			return nil
		}
		if err != nil && err != unix.ENOENT {
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
