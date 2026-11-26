# Docker reference provider

The Docker provider runs commands and file operations through a local
Unix-socket daemon on Linux or macOS. It supports argv, POSIX `sh`, Bash and an
optional PowerShell image. It uses the same workspace for shell, file and search
operations. The provider moves to `packages/provider-docker` in milestone 7. The
paths below refer to this checkout.

Install the provider extension and its dependencies in a trusted directory
outside the writable workspace. For example, install them in a separate package
under `~/.pi/agent/` and load the extension by absolute path. Commands with
write access to a checkout can rewrite packages installed in that checkout.
Project trust allows extension code to load. Live checkout writes require an
explicit provider setting.

## Run this checkout

From `packages/sdk`, pull the pinned image and build the SDK.

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./examples/docker/src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker pull "$image"
pnpm build
```

Start Pi from the project that you want to work on. Load the provider by
absolute path from a separate checkout outside that project.

```sh
pi -e /absolute/path/to/byos/packages/sdk/examples/docker/src/index.ts
```

The provider resolves the local Docker CLI and the daemon endpoint at
configuration time. `DOCKER_HOST`, `DOCKER_CONTEXT` and the current Docker
context can select the endpoint. Use trusted absolute overrides for the
executable and socket when needed. The daemon socket remains outside the
workload. In the target design the provider loads the [Pi integration][pi] when
its extension factory runs.

For the checkout's offline shell preset, load `src/shell-profile.ts` in place of
`src/index.ts` with Pi's `--tools bash` option. The preset uses a guard to
require Docker, network denial and isolation from host user data and system
files.

[pi]: ../../docs/pi-integration.md

## Workspace configuration

<!-- `outsideDestinations` and `outsideApproval` are provisional. -->

Ordinary opening uses the live checkout. Pi's tools share it, with write access
only when the configured policy allows it. The provider declares separate
profiles for explicit copies. The project's trust setting selects neither the
workspace nor the policy. The [workspace guide][editing] describes live work and
explicit copies for permission review.

Put the configured policy, shell and cleanup settings in the provider's settings
file. Configure protection for particular paths in the same file. For commands
that need more access, set `outsideDestinations` and `outsideApproval` there as
well. The [shared settings reference][outside] lists the accepted values.

[editing]: workspace-editing.md
[outside]: ../../docs/api-protocol.md#provider-settings

## Optional PowerShell image

Build the image from `packages/sdk` with BuildKit on amd64 or arm64.

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./examples/docker/src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker build --build-arg NODE_IMAGE="$image" --iidfile /tmp/byos-powershell-image examples/docker/src/powershell
```

Pass the image ID to `createDockerProvider({ powerShellImage })`. Set
`BYOS_DOCKER_POWERSHELL_IMAGE` to test that image in the real-provider suite.
PowerShell jobs are non-interactive and use the same workspace as file
operations.

## Cleanup and verification

An allocation's recovery descriptor identifies its daemon and allocation ID.
After a host crash, inspect containers on that daemon with the label
`io.pi-byos.reference=<allocation-id>`. Remove the matching containers and then
the volume from the descriptor. A disconnected client cannot establish that the
daemon stopped the workload. Inspect the reported allocation before removing
resources.

Run `pnpm test:provider` with a local daemon and the pinned image available. Set
`BYOS_DOCKER_EXECUTABLE` and `BYOS_DOCKER_SOCKET` to override discovery. The
[provider testing guide][testing] describes the target conformance suite. The
[Docker session tests][session] exercise the real Pi and Docker runtime from
this checkout.

[testing]: ../../docs/provider-testing.md
[session]: test/session.test.ts
