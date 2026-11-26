# Docker reference provider

The Docker provider runs commands and file operations through a local
Unix-socket daemon on Linux or macOS. It supports argv, POSIX `sh`, Bash and an
optional PowerShell image. It uses the same workspace for shell, file and search
operations. The paths below refer to this checkout.

Install the provider extension and its dependencies in a trusted directory
outside the writable workspace. For example, install them in a separate package
under `~/.pi/agent/` and load the extension by absolute path. Commands with
write access to a checkout can rewrite packages installed in that checkout.
Project trust allows extension code to load. The configured policy controls
writes to the live checkout.

## Run this checkout

From `packages/provider-docker`, pull the pinned image and build the provider.

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker pull "$image"
pnpm build
```

Start Pi from the project that you want to work on. Load the provider by
absolute path from a separate checkout outside that project.

```sh
pi -e /absolute/path/to/byos/packages/provider-docker/src/index.ts
```

The provider resolves the local Docker CLI and the daemon endpoint at
configuration time. `DOCKER_HOST`, `DOCKER_CONTEXT` and the current Docker
context can select the endpoint. Use trusted absolute overrides for the
executable and socket when needed. The daemon socket remains outside the
workload. In the target design the provider loads the [Pi integration][pi] when
its extension factory runs.

For the checkout's offline shell preset, load `src/shell-profile.ts` in place of
`src/index.ts` with Pi's `--tools bash` option. The provider ships this preset
with a default policy that denies network access and access to host user data
and system files.

[pi]: ../sdk/docs/pi-integration.md

## Workspace configuration

<!-- `allowEscalation`, `escalate` and `/byos log` are provisional. -->

Ordinary opening uses the live checkout. Pi's tools share it, with write access
only when the configured policy allows it. The provider declares separate
profiles for explicit copies. The project's trust setting selects neither the
workspace nor the policy. The [workspace guide][editing] describes live work and
explicit copies for permission review.

The example supplies shared settings through provider registration. The default
permits live checkout writes and denies network access, host user data and host
system files. Docker mounts the checkout's `.pi` directory read-only to protect
Pi's project settings. Create an empty `.pi` directory if the checkout lacks
one. Opening fails if Docker cannot mount the checkout with the selected policy.

Milestone 5 adds `escalate` for Bash, the `allowEscalation` setting and the
`/byos log` command for inspecting decisions.

[editing]: workspace-editing.md

## Host saves on macOS

OrbStack uses VirtioFS to share the live checkout. Around the completion of an
atomic rename, a read can return the new contents cut to the previous file
length. The [rename race probe][rename-probe] observed one truncated read within
about 1 ms of completion with a bind mount and again with a local volume. The
window can last longer under load. Run the probe with `bind` or `volume` to
measure from rename completion.

Docker Desktop on macOS uses [VirtioFS by default][docker-sharing]. Its
behaviour during a rename remains untested here.

[rename-probe]: scripts/rename-race-probe.sh
[docker-sharing]:
  https://docs.docker.com/desktop/settings-and-maintenance/settings/#file-sharing

## Optional PowerShell image

Build the image from `packages/provider-docker` with BuildKit on amd64 or arm64.

```sh
image=$(node --input-type=module -e 'import { DOCKER_IMAGE } from "./src/image.ts"; process.stdout.write(DOCKER_IMAGE)')
docker build --build-arg NODE_IMAGE="$image" --iidfile /tmp/byos-powershell-image src/powershell
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

[testing]: ../sdk/docs/provider-testing.md
[session]: test/session.test.ts
