import argparse
import json
import os
import pathlib
import pwd
import select
import shlex
import socket
import subprocess
import tempfile
import threading
import time
import uuid

parser = argparse.ArgumentParser()
parser.add_argument("--mxc")
options = parser.parse_args()
root = pathlib.Path(tempfile.mkdtemp(prefix="byos-linux-"))
workspace = root / "workspace"
workspace.mkdir()
grant = root / "grant"
grant.mkdir()
events = []
stop = threading.Event()
listeners = []
threads = []


def start_thread(target):
    thread = threading.Thread(target=target, daemon=True)
    threads.append(thread)
    thread.start()


tcp = socket.socket()
tcp.bind(("127.0.0.1", 0))
tcp.listen()
listeners.append(tcp)


def receive_tcp():
    while not stop.is_set():
        if select.select([tcp], [], [], 0.1)[0]:
            connection, _ = tcp.accept()
            with connection:
                connection.settimeout(2)
                events.append(connection.makefile("rb").readline(128).decode().strip())
                connection.sendall(b"observed")


start_thread(receive_tcp)


def relay(address):
    server = socket.socket(socket.AF_UNIX)
    server.bind(address)
    server.listen()
    listeners.append(server)

    def serve():
        while not stop.is_set():
            if select.select([server], [], [], 0.1)[0]:
                connection, _ = server.accept()
                with (
                    connection,
                    socket.create_connection(tcp.getsockname(), timeout=2) as upstream,
                ):
                    connection.settimeout(2)
                    upstream.sendall(connection.makefile("rb").readline(128))
                    connection.sendall(upstream.recv(4096))

    start_thread(serve)
    return address


pathname = relay(str(workspace / "relay.sock"))
external = relay(str(grant / "relay.sock"))
alias = workspace / "alias.sock"
alias.symlink_to(external)
hard_alias = workspace / "hardlink.sock"
hard_alias.hardlink_to(external)
abstract = relay("\0byos-" + uuid.uuid4().hex)
client = """import socket
import sys

address = sys.argv[1]
if address.startswith('@'):
    address = address.replace('@', '\\0', 1)

try:
    with socket.socket(socket.AF_UNIX) as connection:
        connection.settimeout(2)
        connection.connect(address)
        connection.sendall((sys.argv[2] + '\\n').encode())
        print(connection.recv(4096).decode())
except OSError as error:
    print(type(error).__name__)
    sys.exit(3)
"""

varlink_client = r"""import json
import socket
import sys

request = {
    'method': 'io.systemd.Resolve.ResolveHostname',
    'parameters': {'name': sys.argv[2], 'family': 2, 'flags': 0}
}
with socket.socket(socket.AF_UNIX) as connection:
    connection.settimeout(4)
    connection.connect(sys.argv[1])
    connection.sendall((json.dumps(request) + '\0').encode())
    print(connection.recv(8192).decode().replace('\0', ''))
"""

native_runner = pathlib.Path(__file__).with_name("native.py")


def native_run(command, readonly, writable):
    result = subprocess.run(
        [
            "python3",
            str(native_runner),
            options.mxc,
            json.dumps([command, str(workspace), readonly, writable]),
        ],
        check=False,
        capture_output=True,
        text=True,
        timeout=12,
    )
    if result.returncode:
        raise RuntimeError(result.stderr)
    native = json.loads(result.stdout)
    assert native["status"] == 0 and native["nativeStatus"] == 0, native
    return native


def run_case(label, address, isolate, writable=False):
    nonce = uuid.uuid4().hex
    command = ["python3", "-c", client, address.replace("\0", "@", 1), nonce]
    if isolate:
        command = (
            [
                "bwrap",
                "--ro-bind",
                "/",
                "/",
                "--proc",
                "/proc",
                "--dev",
                "/dev",
                "--unshare-net",
            ]
            + (["--bind", str(workspace), str(workspace)] if writable else [])
            + command
        )
    result = subprocess.run(
        command, check=False, capture_output=True, text=True, timeout=5
    )
    print(
        json.dumps(
            {
                "case": label,
                "exit": result.returncode,
                "output": result.stdout.strip(),
                "error": result.stderr.strip(),
                "observed": nonce in events,
            }
        ),
        flush=True,
    )
    expected = label != "abstract-new-network"
    assert (result.returncode, result.stdout.strip(), nonce in events) == (
        0 if expected else 3,
        "observed" if expected else "ConnectionRefusedError",
        expected,
    ), label


try:
    run_case("pathname-host-control", pathname, False)
    run_case("pathname-read-write-new-network", pathname, True, True)
    run_case("pathname-read-only-new-network", pathname, True)
    run_case("explicit-read-only-grant-new-network", external, True)
    run_case("symlink-grant-alias-new-network", str(alias), True)
    run_case("hardlink-host-control", str(hard_alias), False)
    run_case("hardlink-read-only-new-network", str(hard_alias), True)
    run_case("abstract-host-control", abstract, False)
    run_case("abstract-new-network", abstract, True)

    if options.mxc:
        for label, target, readonly, writable, expected in [
            ("native-workspace-read-write", pathname, [], [str(workspace)], True),
            ("native-workspace-read-only", pathname, [str(workspace)], [], True),
            (
                "native-explicit-read-only-grant",
                external,
                [str(workspace), str(grant)],
                [],
                True,
            ),
            (
                "native-alias-read-only-grant",
                str(alias),
                [str(workspace), str(grant)],
                [],
                True,
            ),
            (
                "native-hardlink-read-only-grant",
                str(hard_alias),
                [str(workspace), str(grant)],
                [],
                True,
            ),
            (
                "native-abstract-denied-network",
                abstract.replace("\0", "@", 1),
                [str(workspace)],
                [],
                False,
            ),
        ]:
            nonce = uuid.uuid4().hex
            native = native_run(
                shlex.join(["python3", "-c", client, target, nonce]), readonly, writable
            )
            observed = nonce in events
            print(
                json.dumps({"case": label, "native": native, "observed": observed}),
                flush=True,
            )
            assert (native["exitCode"], native["stdout"], observed) == (
                0 if expected else 3,
                "observed\n" if expected else "ConnectionRefusedError\n",
                expected,
            ), label

    dns = socket.socket(socket.AF_INET, socket.SOCK_DGRAM)
    listeners.append(dns)
    dns.bind(("0.0.0.0", 53))
    dns_events = []

    def serve_dns():
        while not stop.is_set():
            if select.select([dns], [], [], 0.1)[0]:
                data, peer = dns.recvfrom(4096)
                offset = 12
                labels = []
                while data[offset]:
                    length = data[offset]
                    labels.append(data[offset + 1 : offset + 1 + length].decode())
                    offset += length + 1
                dns_events.append(".".join(labels))
                dns.sendto(
                    data[:2]
                    + b"\x81\x80"
                    + data[4:6]
                    + b"\0\1\0\0\0\0"
                    + data[12 : offset + 5]
                    + b"\xc0\x0c\0\1\0\1\0\0\0\0\0\4\xc0\0\2\1",
                    peer,
                )

    start_thread(serve_dns)
    pathlib.Path("/run/dbus").mkdir(exist_ok=True)
    subprocess.run(["dbus-daemon", "--system", "--fork"], check=True)
    pathlib.Path("/etc/systemd/resolved.conf").write_text(
        "[Resolve]\nFallbackDNS=\nDNS="
        + socket.gethostbyname(socket.gethostname())
        + ":"
        + str(dns.getsockname()[1])
        + "\nDNSStubListener=no\nCache=no\nReadEtcHosts=no\nDNSSEC=no\nLLMNR=no\nMulticastDNS=no\n"
    )
    runtime = pathlib.Path("/run/systemd/resolve")
    runtime.mkdir(parents=True, exist_ok=True)
    user = pwd.getpwnam("systemd-resolve")
    os.chown(runtime, user.pw_uid, user.pw_gid)
    with open(root / "resolved.log", "w+") as log:
        daemon = subprocess.Popen(
            ["/usr/lib/systemd/systemd-resolved"], stdout=log, stderr=log
        )
        try:
            resolver = "/run/systemd/resolve/io.systemd.Resolve"
            for _ in range(100):
                if pathlib.Path(resolver).exists():
                    break
                if daemon.poll() is not None:
                    raise RuntimeError(
                        "resolved exited: " + (root / "resolved.log").read_text()
                    )
                time.sleep(0.05)
            for isolate in [False, True]:
                name = uuid.uuid4().hex + ".example.test"
                command = ["python3", "-c", varlink_client, resolver, name]
                if isolate:
                    command = [
                        "bwrap",
                        "--ro-bind",
                        "/",
                        "/",
                        "--proc",
                        "/proc",
                        "--dev",
                        "/dev",
                        "--unshare-net",
                    ] + command
                result = subprocess.run(
                    command, check=False, capture_output=True, text=True, timeout=6
                )
                print(
                    json.dumps(
                        {
                            "case": "resolver-new-network"
                            if isolate
                            else "resolver-host-control",
                            "exit": result.returncode,
                            "response": result.stdout.strip(),
                            "error": result.stderr.strip(),
                            "observed": name in dns_events,
                        }
                    ),
                    flush=True,
                )
                assert result.returncode == 0 and name in dns_events, (
                    "resolver egress control"
                )

            if options.mxc:
                name = uuid.uuid4().hex + ".example.test"
                native = native_run(
                    shlex.join(["python3", "-c", varlink_client, resolver, name]),
                    [str(workspace)],
                    [],
                )
                observed = name in dns_events
                print(
                    json.dumps(
                        {
                            "case": "native-resolver-baseline",
                            "native": native,
                            "observed": observed,
                        }
                    ),
                    flush=True,
                )
                assert native["exitCode"] == 0 and observed

                name = uuid.uuid4().hex + ".example.test"
                native = native_run(
                    shlex.join(["python3", "-c", varlink_client, resolver, name]),
                    [str(workspace), "/run/systemd/resolve"],
                    [],
                )
                observed = name in dns_events
                print(
                    json.dumps(
                        {
                            "case": "native-resolver-explicit-grant",
                            "native": native,
                            "observed": observed,
                        }
                    ),
                    flush=True,
                )
                assert native["exitCode"] == 0 and observed

            resolver_file = root / "resolv.conf"
            resolver_file.write_text(
                "nameserver "
                + socket.gethostbyname(socket.gethostname())
                + "\noptions timeout:1 attempts:1\n"
            )
            direct_client = """import socket
import sys

try:
    print(socket.getaddrinfo(sys.argv[1], None, socket.AF_INET, socket.SOCK_STREAM)[0][4][0])
except socket.gaierror:
    print('dns-unavailable')
    sys.exit(4)
"""
            for isolate in [False, True]:
                name = uuid.uuid4().hex + ".example.test"
                command = [
                    "bwrap",
                    "--ro-bind",
                    "/",
                    "/",
                    "--proc",
                    "/proc",
                    "--dev",
                    "/dev",
                    "--tmpfs",
                    "/run/systemd/resolve",
                    "--ro-bind",
                    str(resolver_file),
                    "/etc/resolv.conf",
                ]
                if isolate:
                    command += ["--unshare-net"]
                command += ["python3", "-c", direct_client, name]
                result = subprocess.run(
                    command, check=False, capture_output=True, text=True, timeout=6
                )
                print(
                    json.dumps(
                        {
                            "case": "resolver-file-denied-network"
                            if isolate
                            else "resolver-file-permitted-network",
                            "exit": result.returncode,
                            "response": result.stdout.strip(),
                            "observed": name in dns_events,
                        }
                    ),
                    flush=True,
                )
                assert (
                    result.returncode,
                    result.stdout.strip(),
                    name in dns_events,
                ) == (
                    4 if isolate else 0,
                    "dns-unavailable" if isolate else "192.0.2.1",
                    not isolate,
                )

        finally:
            daemon.terminate()
            daemon.wait(timeout=5)
            log.close()
finally:
    stop.set()
    for thread in threads:
        thread.join(timeout=3)
    for listener in listeners:
        listener.close()
