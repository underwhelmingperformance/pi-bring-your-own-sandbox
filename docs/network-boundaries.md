# Network denial and host IPC

`networkAccess: 'denied'` blocks outbound network access, including relays
through host services. An IP firewall or a network namespace alone cannot
establish that policy when accessible host IPC can relay traffic. A provider
that cannot block those routes must use `provider-default`. This investigation
does not add an IP-only policy or change satisfaction ordering.

## Observed results

The probes used MXC SDK 1.0.1 on macOS ARM64 and its distributed ARM64 Linux
library inside an OrbStack VM. The Linux image used Ubuntu 24.04, Bubblewrap
0.9.0-1ubuntu0.3 and systemd-resolved 255.4-1ubuntu8.18. Every connection used a
fresh nonce. Independent TCP and DNS listeners outside the sandbox recorded
requests; backend exit status alone was not treated as evidence of isolation.

| Runtime and exposure                                                       | Independent observation                                                   |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Host controls                                                              | Workspace socket relay and abstract socket relay both reached TCP.        |
| MXC Seatbelt, writable workspace                                           | A pathname socket relayed traffic despite native egress denial.           |
| MXC Seatbelt, read-only workspace                                          | The socket connection failed; no nonce reached TCP.                       |
| MXC Seatbelt, explicit writable grant or its symlink alias                 | The socket relayed traffic.                                               |
| MXC Seatbelt, explicit read-only grant or its symlink alias                | The connection failed; no nonce reached TCP.                              |
| MXC Seatbelt, hardlink in writable workspace with read-only original grant | Connection failed; no nonce reached TCP.                                  |
| MXC Seatbelt, hardlink in read-only workspace with writable original grant | The socket relayed traffic.                                               |
| MXC Seatbelt, hardlink with both paths read-only                           | Connection failed; no nonce reached TCP.                                  |
| Linux namespace, writable or read-only bind mount                          | A pathname socket relayed traffic across the network namespace.           |
| Linux namespace, read-only grant, symlink or hardlink alias                | The pathname socket still relayed traffic.                                |
| Linux namespace, abstract Unix socket                                      | Connection failed; the outer abstract socket was isolated.                |
| MXC 1.0.1 Bubblewrap, writable/read-only workspace                         | Pathname sockets relayed traffic despite native egress denial.            |
| MXC 1.0.1 Bubblewrap, read-only grant, symlink or hardlink alias           | Pathname sockets relayed traffic.                                         |
| MXC 1.0.1 Bubblewrap, abstract socket                                      | Connection failed with no observed nonce.                                 |
| Exposed systemd-resolved Varlink socket                                    | A unique lookup caused an observed DNS query outside the namespace.       |
| MXC 1.0.1 Bubblewrap resolver baseline                                     | The Varlink socket was accessible and caused an observed DNS query.       |
| Hidden resolver directory, regular resolver file                           | Denied networking prevented DNS traffic; permitted DNS resolved normally. |

The resolver returned the controlled server's `192.0.2.1` answer. Queries used
unique `.example.test` labels, cache was disabled, and the independent server
recorded each label. The result therefore demonstrates a real query, not a
cached, hosts-file or synthetic resolver response. The listeners were controlled
local services outside the sandbox's network namespace; the probes did not
contact a public DNS service or demonstrate arbitrary Internet access.

The macOS read-only result refutes a blanket claim that every shared workspace
permits the same relay. Linux read-only mounts do permit socket connection in
these cases. Neither result proves a complete denied-network policy for an
adapter: all exposed services, grants and runtime-specific routes still need
verification.

The Docker example uses a copied volume, mounts neither the host workspace nor
the daemon socket, and uses `--network=none`. Its independent provider suite
passes. These probes do not establish an IPC bypass in that example.

## Pinned and current MXC source

The [earlier Bubblewrap baseline][pinned] binds resolver runtime directories.
The actual 1.0.1 Linux artifact reproduced Varlink access with only its baseline
and a workspace grant. The [current baseline][current] at
`27d0717320ca0dd968e01c40ee7d8c85a158a6f6` excludes those directory mounts; its
[resolver implementation][resolver-file] exposes the resolver file and recreates
the required symlink layout. That change avoids exposing neighbouring runtime
sockets through the baseline. Explicit user grants can still expose those
sockets and need independent checks.

The copied-file probe verifies both the denied and permitted DNS cases for that
arrangement. It does not certify a build of current MXC upstream: the native
runtime used here was the distributed 1.0.1 artifact. Re-run the probes against
any replacement artifact before changing a provider's advertised policy.

[pinned]:
  https://github.com/microsoft/mxc/blob/fda29ac63bc306b7f97f3b86b4b63d44f7f40cf2/src/mxc-sdk/src/backends/bubblewrap/common/bwrap_command.rs
[current]:
  https://github.com/microsoft/mxc/blob/27d0717320ca0dd968e01c40ee7d8c85a158a6f6/src/mxc-sdk/src/backends/bubblewrap/common/bwrap_command.rs
[resolver-file]:
  https://github.com/microsoft/mxc/blob/27d0717320ca0dd968e01c40ee7d8c85a158a6f6/src/mxc-sdk/src/backends/bubblewrap/common/resolver_file.rs

The tested library SHA-256 values were:

```text
Linux ARM64: abe1b604297c62a3b8bdd94e3edd8a91f625ebd38e2ea19177675291dec83fd7
macOS ARM64: ff3009d8966d5dd8e45cc4a5e2982aefdbd207c4cfb391c1a37a95c2c82a776e
```

## Repeat the probes

The [macOS fixture][macos-probe] takes the absolute path to an installed MXC
SDK's `dist/v1/index.js`. It runs native calls in bounded child processes so
synchronous FFI cannot block the independent observer. Set `BYOS_MXC_SDK_ENTRY`
to that file, then run from this checkout:

```sh
node --input-type=module <<'JS'
import { createJiti } from 'jiti';

const probe = await createJiti(import.meta.url).import(
  './src/fixtures/mxc-network-probe.ts', { default: true }
);
const entry = process.env.BYOS_MXC_SDK_ENTRY;

if (!entry) throw new Error('Set BYOS_MXC_SDK_ENTRY to the installed SDK entry.');

await probe(entry);
JS
```

The [Linux fixtures][linux-probe] require Docker in a disposable VM. They
install probe tools in an image and copy only the two explicit Python fixture
files. They do not copy an SDK or a repository tree. Set
`BYOS_MXC_LINUX_LIBRARY` to the installed SDK's matching Linux `libmxc_ffi.so`.
The raw C ABI probe uses the same 1.0.0 request contract as the 1.0.1 Node
binding, with telemetry disabled.

```sh
docker build -t byos-boundary-investigation investigations/network-linux

docker run --rm \
  --cap-add SYS_ADMIN --cap-add NET_ADMIN \
  --security-opt seccomp=unconfined \
  --security-opt systempaths=unconfined \
  --mount "type=bind,source=$BYOS_MXC_LINUX_LIBRARY,target=/mxc.so,readonly" \
  byos-boundary-investigation --mxc /mxc.so
```

Bubblewrap needs namespace capabilities and an unmasked proc filesystem for its
nested PID namespace. The command retains Docker's ordinary device restrictions
and does not use privileged mode or mount the host workspace. Run these trusted
fixtures in a disposable VM, not as a policy for untrusted workloads. Omitting
the library mount and `--mxc` runs the independent namespace/resolver cases
only. Native calls, subprocess probes and socket operations have finite
timeouts.

[macos-probe]: ../src/fixtures/mxc-network-probe.ts
[linux-probe]: ../investigations/network-linux

Providers claiming denied networking must independently probe pathname and
abstract sockets, writable and read-only grants, aliases, resolver services and
other exposed host services. A successful read-only filesystem test does not
establish socket denial. The [provider test kit][testing] requires independent
policy verification and must not infer network isolation from native options.

[testing]: provider-testing.md
