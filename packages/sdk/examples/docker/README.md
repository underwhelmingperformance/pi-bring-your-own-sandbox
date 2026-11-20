# Docker reference provider

This example implements the public provider contract with a local Docker daemon.
It supports argv, POSIX `sh`, Bash, optional PowerShell, and the file operations
for reading, writing and listing. Shell commands, file operations, `search.find`
and `search.grep` use the same workspace volume.

The framework's runtime does not depend on Docker. Registering the example does
not contact the daemon. Docker is required when a consumer acquires an
explicitly selected `example.docker` backend.

## Load and select the provider

Use a local Unix-socket Docker daemon on Linux or macOS. The configuration
defaults to `/usr/bin/docker` and `/var/run/docker.sock`. Set absolute
`executable` and `socketPath` values for another local installation. The
management CLI receives an empty environment and an explicit daemon address;
Docker context and environment settings do not select another daemon.

Run these commands from `packages/sdk`. Pull the pinned image before opening a
backend:

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./examples/docker/src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker pull "$image"
pnpm build
```

From this checkout, load the provider:

```sh
pi --no-extensions -e ./examples/docker/src/index.ts --byos-docker-copy
```

For development with only the BYOS Bash tool, load the shell profile from
`packages/sdk`. The profile routes Pi's interactive shell through Docker too.

```sh
pi --no-extensions --tools bash -e ./examples/docker/src/shell-profile.ts --byos-docker-copy
```

These commands select a private copy explicitly. Without the flag, both entry
points request mediated host editing when Pi reports a trusted project. Pi can
trust a project without a saved trust decision. The production provider
currently supports private copies only. If an ordinary tool requests the trusted
default, Pi displays the private-copy option and the open fails before Docker
allocates resources.

The extension selects the default once per runtime. It reads project trust from
the matching Pi session, even when an SDK consumer passes only the session ID
and working directory. An extension that acquires during an earlier
`session_start` handler should pass its Pi context. Before the Docker extension
receives that event, it can only use the acquisition context. A false or
unavailable trust decision at configuration selects a private copy. SDK
consumers can explicitly request `workspaceRelationship: 'copied'` at
acquisition. Review snapshots always use fresh read-only copies.

The profile preserves a narrower Pi tool selection. It checks every model tool
call, including indirect calls and tools that another extension reactivates.
Bash can request outside execution through BYOS's configured approval policy.

For another project, copy `examples/docker/src` into `.pi/extensions/docker`. Pi
loads its `index.ts`, which re-exports the extension factory. Keep the launcher
file beside the provider modules. The example uses public imports from
`pi-bring-your-own-sandbox/api` and needs the framework as a normal project
dependency.

Pi supplies TypeBox at runtime. Add `typebox` as a development dependency to
type-check the copied example outside Pi.

Loading the example selects `example.docker`. Its development copies allow reads
and writes. To customise the provider, write an extension factory that calls
`registerSandboxProvider` with the declaration returned by
`createDockerProvider` and a `configure` callback. Return raw Docker input under
`configuration`, and provide a complete policy or use the declaration's default.
The callback can read your extension's own settings.

Use `read-only` for a read-only copy of the workspace. The provider rejects
unsupported filesystem or network policies before allocation. An extension can
also call `registerSandboxDiagnostics(pi)` to expose `/byos status`.

SDK consumers use the selected provider automatically. The example supplies `sh`
for user commands and Bash for the model `bash` tool. The optional image
described below adds PowerShell. Load `/pi-tools` separately to route supported
Pi shell hooks. See the [integration coverage table][coverage] for those hooks
and the upstream file/search gaps.

[coverage]: ../../docs/pi-integration.md

## Optional PowerShell image

Build the reference toolchain once from `packages/sdk` with BuildKit on amd64 or
arm64. The launcher uses Node from the pinned Debian 12 image, and PowerShell
uses the Debian 12 package `libicu72`. The Dockerfile requires support for
`ADD --checksum`. Docker verifies the PowerShell archive for the daemon's
architecture before it unpacks the runtime.

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./examples/docker/src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker build --build-arg NODE_IMAGE="$image" --iidfile /tmp/byos-powershell-image examples/docker/src/powershell
```

In your trusted extension, pass the full image ID from that file to
`createDockerProvider({ powerShellImage })` when registering the provider. The
provider runs a PowerShell startup check on opening. Shell and argv jobs use the
selected image and the same workspace. PowerShell starts without profiles and
runs non-interactively with the same 128 MiB memory and 64-process limits as
other jobs. File operations continue to use the pinned Node helper image. To
include the PowerShell conformance scenario, set `BYOS_DOCKER_POWERSHELL_IMAGE`
to the image ID when running `pnpm test:provider`.

## Separate Docker destination for outside execution

A trusted extension can register a second local Docker destination for approved
commands. For example, use a writable copy for a package build while the
ordinary session has read-only access. The destination imports the host checkout
when it opens. Edits in either Docker volume affect only that volume.

```typescript
import {
  configureOutsideExecution,
  registerSandboxProvider
} from 'pi-bring-your-own-sandbox/api';

import { createDockerOutsideDestination } from './outside.js';
import { createDockerProvider } from './provider.js';

registerSandboxProvider(pi, {
  ...createDockerProvider(),
  outsideSandbox: createDockerOutsideDestination({
    executable: '/usr/bin/docker',
    socketPath: '/var/run/docker.sock'
  })
});
configureOutsideExecution(pi, () => ({ destination: 'provider' }));
```

The SDK requests approval for each outside invocation. The Docker destination
keeps external networking disabled and uses a separate allocation even when both
connections use the same daemon. Set the optional second argument to
`{ powerShellImage }` for an outside destination with the PowerShell toolchain.

## Workspace and process behaviour

Opening creates a labelled Docker volume and copies the host workspace into
`/workspace`. The copy includes hidden files and preserves symbolic links.
Commands share the volume for that generation. Host changes after opening are
not synchronised, and target changes are not copied back. Disposal deletes the
volume. An empty workspace is writable in read-write mode.

Import accepts up to 512 MiB of regular-file contents, 100,000 entries and 128
directory levels, including entries under dependency directories. Filenames must
be valid UTF-8. The importer preserves internal hard links and symbolic links.
It omits sockets, FIFOs and devices, and rejects regular files with links
outside the source tree. It checks file contents and metadata against the source
a second time before the backend opens. The bootstrap container has one CPU, 256
MiB of memory and a limit of 32 processes. The writable workspace volume has no
storage quota after import.

Review snapshots use the same importer with a fresh volume. A review of a
sandbox command copies the live backend volume, including edits made by shell
and file operations. A host-command review copies the host checkout. Each review
mounts its copy read-only and can release it independently.

Each foreground command creates a separate container. Containers have a
read-only runtime image, a private 16 MiB `/tmp`, a limit of 64 processes, a 128
MiB memory limit and one CPU. Network mode is `none`. Job containers do not
mount the host workspace or Docker socket. Docker logging is disabled for job
containers; stdout and stderr are streamed to the SDK.

A protected Node launcher starts the requested command as UID and GID 65534. The
launcher retains a different UID so a child cannot modify its control stream
through `/proc`. The container grants the launcher only the capabilities needed
for privilege changes and target-directory access. `no-new-privileges` prevents
the child from gaining privilege through executable file attributes.

The launcher passes argv without a shell, applies target environment overrides
and deletions, and reports code exits, signal exits and spawn failures. Shell
requests explicitly invoke `/bin/sh` or `/bin/bash` for the selected dialect.
Child stdout and stderr are encoded in bounded frames; the SDK receives the
original bytes. The runtime image is pinned by digest and includes the Node
version needed to run the typed launcher. Caller environment overrides affect
the child, including when the child itself is Node. They do not configure the
launcher.

The target home is `/tmp` and resets between operations. Workspace files persist
between operations; processes and changes to private scratch space do not.
Detached background jobs are unsupported. On foreground completion, Docker must
confirm that the container exited and was removed before the provider returns
the child's result.

Cancellation removes the job container through the daemon and waits for the
attached client to finish. A confirmed cancellation permits another operation
against the same workspace volume. Failure to confirm removal reports
unconfirmed termination, which makes the shared SDK backend unhealthy. Losing
the CLI transport does not establish that the target stopped.

File operations share an unprivileged worker container for the open backend. The
first request starts the worker. After 30 idle seconds the provider removes the
worker. The workspace volume persists. A read returns the complete contents of a
regular file up to 16 MiB. Writes accept up to 16 MiB and check the length of
the received input before opening the destination. Directory listings report
symlinks as entries. A read-only workspace rejects write-access checks, file
writes and directory creation. Cancellation removes the worker so later
operations start with a fresh worker.

Search runs in the file worker. Find uses Node's POSIX `path.matchesGlob`.
Patterns containing a slash match paths relative to the search root. Other
patterns match basenames. Wildcards skip leading dots unless the pattern
explicitly matches them. Both searches visit directories in depth-first order
with entries sorted by name. They skip `.git` and `node_modules` at every depth
and ignore repository ignore files. Find reports directory symlinks as entries.
An explicit search root can be a symlink. Below the root, search skips directory
symlinks. Directory listings and searches skip entries whose names contain
invalid UTF-8.

Grep accepts RE2 regular expressions or literal text. RE2 supports Unicode
character classes and case-insensitive matching. It rejects backreferences and
lookaround. The worker loads the matcher from its own read-only package
directory. Grep searches regular files and skips files larger than 16 MiB or
containing NUL bytes. Each returned match can include up to 65,536 context lines
on either side. A larger context request fails only when more than 65,536 lines
exist on one side of a returned match. Both find and grep reject encoded
responses over 16 MiB. Both searches report truncation when another result
exists beyond the requested count.

## Cleanup and recovery

The provider reports a recovery descriptor before allocating the volume. The
descriptor specifies its daemon socket, volume ID and allocation label. The
allocation has no automatic expiry. A host crash requires manual recovery.
Failed opening attempts cleanup and acknowledges successful allocation release
before rejecting. A failure to confirm cleanup preserves the descriptor in the
SDK error. Shutdown cancels active jobs, waits for their completion and removes
the labelled resources. Bare SDK hosts must call `closeSandboxSession` before
disposing a raw Pi session.

A local CLI deadline or output failure rejects immediately, stops its POSIX
process group and closes its pipes. This does not confirm target termination;
cleanup still uses the daemon. If volume or container creation fails without a
confirmed response, the daemon may finish allocation after a cleanup query. The
provider attempts cleanup but keeps the allocation unconfirmed and retains
manual recovery instructions even when the current queries return no resources.

For manual recovery, use the daemon from the provider configuration. Inspect
containers with `io.pi-byos.reference=<allocation-id>`, remove those containers,
then remove the volume with that allocation ID. Inspect the exact allocation ID
from the recovery descriptor. Do not remove other Docker resources.

## Run the real-provider gate

The deterministic gate, `pnpm check`, visibly skips daemon-backed cases. The
separate `pnpm test:provider` gate requires the mount test prerequisites below,
the local daemon and the pinned image and fails if either is unavailable. GitHub
Actions runs this gate in a dedicated Linux job.

For a non-default installation:

```sh
BYOS_DOCKER_EXECUTABLE=/absolute/path/to/docker \
BYOS_DOCKER_SOCKET=/absolute/path/to/docker.sock \
pnpm test:provider
```

The gate runs the reusable provider suite in both workspace modes and SDK tests
through a real Pi runtime. It checks argv, cwd, environment changes, stdout and
stderr, non-zero exits, signals, spawn failures, output bounds, cancellation of
descendants, independent cleanup, host sentinels, copied symlink escapes,
network denial, empty workspaces and distinct allocations. The network test
first reaches a controlled server from a bridge-connected container, then checks
that the isolated target cannot reach the same server.

These checks establish behaviour on the tested Docker daemon and image. Docker's
[container removal][removal] documentation describes forced removal. The [Node
image repository][node-image] documents the official runtime image.

[removal]: https://docs.docker.com/reference/cli/docker/container/rm/
[node-image]: https://github.com/nodejs/docker-node

## Verify FUSE mount privileges

The real Docker suite includes a mount test for Linux Docker and OrbStack. It
requires a Go toolchain, the pinned Node image and a daemon that can provide
`/dev/fuse`. Run `pnpm test:provider` to build the test binary for the daemon's
architecture and run the workload.

The first build needs access to the Go modules pinned in `test/mount/go.sum` or
a populated Go module cache. On AppArmor-enabled Docker hosts, install the test
profile with `sudo apparmor_parser -r test/mount/apparmor` from the Docker
example directory. The profile permits a FUSE mount at `/workspace`, removal of
the control mount at `/control` and execution of the shell and Node.

Only the filesystem service gets a bind mount of the host checkout. The workload
runs as UID and GID 65534. The test inspects its capabilities and checks that it
cannot access the FUSE device or control socket.

The writable mount test replaces a regular file in the workspace root. The host
observes the write while the workload still has the file open, then links the
file outside the workspace and replaces the workspace entry by rename. The
workload reads the replacement. A write on the old descriptor fails and the
retained host file keeps its contents. The workload also shrinks an open file,
extends it with zero bytes and checks that a resize beyond 16 MiB fails with
`EFBIG`. On a read-only mount the workload checks for `EROFS`.

For ordinary authorised saves, the last replacement of a directory entry wins.
The test replaces a file on the host and saves the same file from the workload.
The host reads the workload's version. A second file stays open across a host
rename within the workspace root. A further write to that descriptor returns
`ESTALE`. The host reads the original contents under the new name.

The writable prototype permits up to 16 successful file creations per service.
New files must be in the workspace root and have a non-hidden name. The service
restricts their permissions to owner read and write. The service counts a file
as soon as the backing filesystem creates it. If a subsequent metadata read
fails, the file still exists. Writes require the file's group to match the
service's group, including when a setgid directory supplies the group. A
read-only mount rejects creation. The service refuses workload renames and
removals. Linux resolves the operands of these operations by name, so a host
process can substitute an entry after the service has checked it. Enabling them
in a shared workspace requires enforcement at the point of mutation.

A second mount runs the provider's file helper. A host read verifies the new
contents after a writable save. On a read-only mount the helper returns its
permission-denied status and the host file keeps its original contents. The
mount tests use a prototype FUSE service. The production provider copies the
workspace into a volume.

The prototype stages each FUSE write request separately. A large application
write can produce several requests and the host can see each intermediate
version of the file. Filesystems that cannot preserve the source file's extended
attributes can reject writes. A concurrent host replacement can occur between
the final identity check and the rename. In that case the staged write can
overwrite the new host file.

### Authorising saves on the host

A host filesystem check can see the object selected for a rename or unlink. The
[macOS test][darwin-mutations] starts a child process under Seatbelt in a
temporary host directory. The profile permits writes to workspace files with a
single name and denies writes to a protected subtree. The host replaces a file,
the child reads the new contents and saves by rename, and the host checks the
result. The test also checks an absent protected file, renaming an ancestor of
the protected directory, creating a hard link and modifying a file through an
existing hard link. Apple's `com.apple.SubmitDiagInfo.sb` uses the same
`has-multiple-names` filter for writes.

The [Linux probe][linux-mutations] attaches two deny-only checks to the kernel's
authorisation of rename and unlink. The checks inspect the source and target
entries for a single test process. The loader drops its root credentials before
editing. Run the probe as an ordinary user in a disposable native Linux VM with
Clang, a C compiler, bpftool, libbpf development headers and sudo. From the
Docker example directory, run:

```sh
sh test/mount/linux-mutations/verify.sh
```

The probe passed on arm64 Ubuntu 24.04 with kernel 6.8.0-147 and its default
security modules. It requires kernel BTF and support for attaching BPF programs
to both authorisation functions. In [Linux 6.8][linux-rename], the parent
directories are locked at the rename check, but the kernel locks the file inodes
afterwards. The check sees which entries the rename will use. A link count
observed there does not establish that the count will remain the same until the
rename completes. The probe tests aliases that already exist.

For a checkout on macOS, a check in the Docker VM only sees the guest's view of
the directory entries.

In a one-off test on OrbStack 2.2.5 and macOS 27.0.1, SSHFS 3.7.3 ran inside a
network-isolated container. A root bootstrap had `CAP_SYS_ADMIN` and access to
`/dev/fuse` to mount the test checkout at `/workspace`. The workload ran as UID
65534 with no effective capabilities. SSHFS used `-f` and
`-o passive,allow_other,direct_io,dir_cache=no,attr_timeout=0,entry_timeout=0,negative_timeout=0`.
Two pipes connected the Docker CLI's [standard input and output][passive] to
Apple's `/usr/libexec/sftp-server` on the host. The host restricted writes with
the [test Seatbelt profile][write-profile]. The protected path was `.pi` under
the temporary checkout. The server also required write access to `/dev/null` at
startup. Its debug log confirmed use of the OpenSSH POSIX rename extension.

The workload read a host editor's replacement and saved a temporary file by
rename. The host saw the new contents. Renames over a protected file and a
hard-link alias returned `EACCES`. This experiment used a fixed workload and did
not test confinement of arbitrary SFTP clients or access to the FUSE device from
the workload.

The macOS profile restricts writes and hard-link creation. The Linux probe
checks rename and unlink. It does not check opens for writing, truncation, or
creation of links. A production host service must also confine reads, handle
open file descriptors across host replacements, enforce protected directories
and Git metadata, and release the mount when the session closes.

[darwin-mutations]: test/darwin-mutations.test.ts
[write-profile]: test/mount/darwin-mutations.sb
[linux-mutations]: test/mount/linux-mutations/verify.sh
[linux-rename]:
  https://github.com/torvalds/linux/blob/v6.8/fs/namei.c#L4543-L4575
[passive]: https://github.com/libfuse/sshfs/blob/master/sshfs.rst

## Measuring a copied workspace

From `packages/sdk`, run the benchmark against a local daemon with the pinned
image already present. Set `BYOS_DOCKER_EXECUTABLE` and `BYOS_DOCKER_SOCKET` if
the daemon uses different paths.

```sh
BYOS_DOCKER_BENCHMARK=1 pnpm exec vitest run --config vitest.provider.config.ts examples/docker/test/benchmark.test.ts
```

The fixture imports 100 JavaScript modules of about 1 KiB each. The first read
starts the file worker. Twenty sequential reads of the same file reuse it. Grep
searches all 100 modules. A separate job builds and writes an npm package
archive offline. The benchmark checks the bytes, every search match, the exit
status and the presence of a non-empty archive.

| Local arm64 daemon           | Fresh open | First read | 20 warm reads |   Grep | Package build |
| ---------------------------- | ---------: | ---------: | ------------: | -----: | ------------: |
| OrbStack on macOS            |    1124 ms |     310 ms |       1998 ms | 167 ms |        941 ms |
| Docker in an Ubuntu 24.04 VM |     356 ms |     197 ms |       1719 ms | 120 ms |        599 ms |

Each row reports one run with the image cached. The open time includes workspace
import. The warm-read time includes the checks on the returned bytes.
