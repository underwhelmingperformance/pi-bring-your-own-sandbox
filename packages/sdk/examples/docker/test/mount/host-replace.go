//go:build linux

package main

import (
	"encoding/json"
	"io"
	"log"
	"net"
	"os"
	"strconv"
	"sync"
	"time"

	"golang.org/x/sys/unix"
)

const replacementSocket = "/control/replace"

type hostReplacer struct {
	mu       sync.Mutex
	root     int
	listener *net.UnixListener
	conn     net.Conn
	replies  *json.Decoder
}

type hostChange struct {
	Op       string `json:"op"`
	Target   string `json:"target"`
	Source   string `json:"source,omitempty"`
	Mode     uint32 `json:"mode"`
	Size     string `json:"size,omitempty"`
	Mtime    string `json:"mtime,omitempty"`
	Expected string `json:"expected,omitempty"`
}

func (p *hostReplacer) version(request hostChange, stat unix.Stat_t) (string, error) {
	request.Size = strconv.FormatInt(stat.Size, 10)
	request.Mtime = strconv.FormatInt(stat.Mtim.Nano(), 10)
	id, err := p.exchange(request)
	if err == unix.ENOENT {
		return "", unix.ESTALE
	}
	if err == nil && id == "" {
		return "", unix.EIO
	}
	return id, err
}

func (p *hostReplacer) change(request hostChange) error {
	_, err := p.exchange(request)
	return err
}

func peerCredentials(conn *net.UnixConn) (*unix.Ucred, error) {
	socket, err := conn.SyscallConn()
	if err != nil {
		return nil, err
	}
	var peer *unix.Ucred
	var peerErr error
	if err := socket.Control(func(fd uintptr) {
		peer, peerErr = unix.GetsockoptUcred(int(fd), unix.SOL_SOCKET, unix.SO_PEERCRED)
	}); err != nil {
		return nil, err
	}
	return peer, peerErr
}

func (p *hostReplacer) exchange(request hostChange) (string, error) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.conn == nil {
		if p.listener == nil {
			return "", unix.EIO
		}
		if err := p.listener.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
			return "", err
		}
		conn, err := p.listener.AcceptUnix()
		if err != nil {
			return "", err
		}
		peer, err := peerCredentials(conn)
		if err != nil || peer.Pid <= 0 || peer.Uid != uint32(os.Geteuid()) {
			conn.Close()
			return "", unix.EACCES
		}
		p.listener.Close()
		p.listener = nil
		p.conn = conn
		p.replies = json.NewDecoder(conn)
	}
	if err := p.conn.SetDeadline(time.Now().Add(5 * time.Second)); err != nil {
		return "", err
	}
	if err := json.NewEncoder(p.conn).Encode(request); err != nil {
		p.conn.Close()
		p.conn = nil
		return "", unix.EIO
	}
	var reply struct {
		Status   string
		Identity string
	}
	if err := p.replies.Decode(&reply); err != nil {
		p.conn.Close()
		p.conn = nil
		return "", unix.EIO
	}
	switch reply.Status {
	case "ESTALE":
		return "", unix.ESTALE
	case "OK":
		return reply.Identity, nil
	case "EPERM", "EACCES":
		return "", unix.EACCES
	case "ENOENT":
		return "", unix.ENOENT
	case "EEXIST":
		return "", unix.EEXIST
	case "EISDIR":
		return "", unix.EISDIR
	case "ENOTDIR":
		return "", unix.ENOTDIR
	case "ENOTEMPTY":
		return "", unix.ENOTEMPTY
	case "EINVAL":
		return "", unix.EINVAL
	case "EXDEV":
		return "", unix.EXDEV
	case "EROFS":
		return "", unix.EROFS
	case "ENOSPC":
		return "", unix.ENOSPC
	case "EDQUOT":
		return "", unix.EDQUOT
	case "ENAMETOOLONG":
		return "", unix.ENAMETOOLONG
	default:
		return "", unix.EIO
	}
}

// The VM can cache the old directory entry after macOS has completed the rename.
func (p *hostReplacer) waitForEntry(target string, previous unix.Stat_t) {
	deadline := time.Now().Add(2 * time.Second)
	for {
		entry, err := entryStat(p.root, target)
		if (err == unix.ENOENT && previous.Ino != 0) || (err == nil && (entry.Dev != previous.Dev || entry.Ino != previous.Ino)) {
			return
		}
		if err != nil && err != unix.ENOENT {
			log.Printf("refreshing workspace entry %q: %v", target, err)
			return
		}
		if time.Now().After(deadline) {
			log.Printf("Docker still caches the previous entry for %q", target)
			return
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
