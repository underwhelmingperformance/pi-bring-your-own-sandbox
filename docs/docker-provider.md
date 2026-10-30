# Docker reference provider

The optional example in `examples/docker/src` implements the public provider
contract with a local Docker daemon. It advertises `exec`, POSIX `sh` and Bash.
Filesystem and search facades reject unsupported capability requests.

The framework's runtime does not depend on Docker. Registering the example does
not contact the daemon. Docker is required when a consumer acquires an
explicitly selected `example.docker` backend.

## Load and select the provider

Use a local Unix-socket Docker daemon on Linux or macOS. The configuration
defaults to `/usr/bin/docker` and `/var/run/docker.sock`. Set absolute
`executable` and `socketPath` values for another local installation. The
management CLI receives an empty environment and an explicit daemon address;
Docker context and environment settings do not select another daemon.

Pull the pinned image before opening a backend:

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./examples/docker/src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker pull "$image"
pnpm build
```

From this checkout, load the provider with the diagnostic extension:

```sh
pi --no-extensions -e ./dist/extension.js -e ./examples/docker/src/index.ts
```

For another project, copy `examples/docker/src` into `.pi/extensions/docker`. Pi
loads its `index.ts`, which re-exports the extension factory. Keep the launcher
file beside the provider modules. The example uses public imports from
`pi-bring-your-own-sandbox/api` and needs the framework as a normal project
dependency.

Select the provider in a trusted project's `.pi/byos.json`:

```json
{
  "provider": "example.docker",
  "policy": {
    "workspaceAccess": "read-write",
    "filesystemScope": "workspace-only",
    "networkAccess": "denied"
  },
  "providerConfig": {
    "executable": "/usr/bin/docker",
    "socketPath": "/var/run/docker.sock"
  }
}
```

Use `read-only` for a read-only copy of the workspace. The provider rejects
unsupported filesystem or network policies before allocation. Project settings
apply only after Pi trusts the project; personal selection uses the agent
directory's `byos.json`. `/byos status` reports the selection and effective
boundary.

SDK consumers use the selected provider automatically. The example supplies `sh`
for user commands and Bash for the model `bash` tool. PowerShell is unsupported.
Load `/pi-tools` separately to route supported Pi shell hooks. See the
[integration coverage table][coverage] for those hooks and the upstream
file/search gaps.

[coverage]: pi-integration.md

## Workspace and process behaviour

Opening creates a labelled Docker volume and copies the host workspace into
`/workspace`. The copy includes hidden files and preserves symbolic links.
Commands share the volume for that generation. Host changes after opening are
not synchronised, and target changes are not copied back. Disposal deletes the
volume. An empty workspace is writable in read-write mode.

The workspace volume has no storage quota. Opening copies the complete workspace
with a bootstrap container that has no job CPU, memory or process limits. A
large source tree or a job that fills `/workspace` can exhaust daemon storage;
the job limits below do not bound that volume. Run this example only with
workspace sizes and daemon storage that you can manage. Enforceable storage
quotas require additional provider support.

Each foreground operation creates a separate container. Containers have a
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
separate `pnpm test:provider` gate requires the local daemon and pinned image
and fails if either is unavailable. GitHub Actions runs this gate in a dedicated
Linux job.

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
