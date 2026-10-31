# Writing a consumer extension

Add `pi-bring-your-own-sandbox` as a normal dependency of the extension project.
Import the SDK from `pi-bring-your-own-sandbox/api`. Pi supplies the extension
context and event bus. The supported host baseline is Pi 1.4.0.

The user chooses a sandbox provider separately from installing a consumer.
Without configuration, `getSandbox` returns the built-in host passthrough
backend. Selecting a provider changes subsequent consumer execution without a
consumer source change. Configuration is cached for a generation; a new session
or extension reload applies a changed selection. A configured provider failure
is returned as an error.

## Run the example

Build and pack this development checkout:

```sh
pnpm build
pnpm pack --pack-destination /tmp/byos-artifacts
```

In an extension project, install the tarball:

```sh
pnpm add /tmp/byos-artifacts/pi-bring-your-own-sandbox-0.0.0.tgz
```

Copy `examples/consumer/src` from the package into `.pi/extensions/workspace`.
Pi discovers the directory's `index.ts`, which re-exports the extension factory.
The example registers `sandbox_pwd`. It requires a target with a `pwd`
executable, including POSIX passthrough and the [Docker reference
provider][docker].

[docker]: docker-provider.md

From this checkout, load the source directly:

```sh
pi --no-extensions -e ./examples/consumer/src/index.ts
```

No sandbox configuration is needed for host execution. To use Docker, load its
provider extension and apply the explicit selection in the Docker guide. The
same consumer files work in both cases.

## Acquire and execute

The helper accepts an injected `SandboxClient` and a live Pi context:

```typescript
import type {
  ProcessResult,
  SandboxClient,
  SandboxContext,
  SandboxHost
} from 'pi-bring-your-own-sandbox/api';

export async function inspectWorkspace(
  client: SandboxClient,
  pi: SandboxHost,
  context: SandboxContext,
  signal?: AbortSignal
): Promise<ProcessResult> {
  const options = signal === undefined ? {} : { signal };
  const sandbox = await client.getSandbox(pi, context, options);
  return sandbox.exec({ kind: 'argv', executable: 'pwd', args: [] }, options);
}
```

Call acquisition from a tool, command or event after extension loading. Pass the
per-tool signal from `execute` to both acquisition and execution. The SDK also
applies its generation lifetime and default deadlines. Cancelling an acquisition
waiter does not cancel shared startup.

Argv requests preserve argument boundaries. Shell requests require an explicit
advertised dialect. Paths, cwd and environment overrides refer to the target;
metadata describes whether its workspace is shared, copied or remote. Use the
SDK file and search facades for target files. A target path is not necessarily
accessible through the host's filesystem APIs.

The broker shares a backend across consumers in the generation. The returned
facade exposes immutable metadata and operations. The broker owns allocation and
disposal. Consumer code does not choose another provider for individual
requests.

Require additional capabilities or policy only when the extension needs them.
For example, a denied-network requirement rejects acquisition from passthrough.
Requirements check the selected backend and do not change the user's selection.
Unsupported operations return typed capability errors.

## Tool results, approval and errors

Register a normal Pi tool and execute the SDK helper inside its `execute`
callback. Pi performs argument validation and tool approval before invoking the
callback. The example reports stdout, stderr, exit status and omitted byte
counts as JSON. Non-zero process exits are normal results; the consumer decides
how to present them.

Direct SDK calls follow the consumer's own control flow. They do not create a Pi
tool call. Extensions that need Pi's tool approval should invoke a registered
tool through Pi's public tool path. The optional framework `/pi-tools` entry
connects supported built-in shell hooks; see the [coverage table][coverage].

[coverage]: pi-integration.md

SDK failures use concrete typed errors. Use
`isSandboxError(error, ConcreteErrorClass)` to narrow errors when extensions may
have separate installed SDK copies. Constructor identity can differ across those
copies. Avoid parsing error messages. Unconfirmed termination makes the shared
backend unhealthy and prevents subsequent operations. The SDK does not replay
the failed operation or switch to passthrough.

## Host shutdown and tests

An embedded host with an explicit Pi `agentDir` must initialise the framework
from its first extension factory:

```typescript
initialiseSandboxHost(pi, { agentDirectory });
```

Import `initialiseSandboxHost` from `/api`. Pass the same absolute directory as
Pi's `agentDir`, before the broker or consumer factories run. This binds the
shared service for all SDK copies without changing the process environment. Late
or repeated initialisation fails. The ordinary Pi CLI requires no binding.

Pi's session runtime emits the lifecycle events needed for cleanup. A host that
embeds a raw `AgentSession` must call `closeSandboxSession(pi, context)` before
`session.dispose()`. Inspect the close report and surface its recovery metadata
when cleanup is unconfirmed. Routine diagnostics should not serialise error
causes.

`pnpm test:integration` checks the example through a real Pi runtime with a
scripted model and fake approval. It runs the same consumer with default
passthrough, a direct in-memory provider and a provider with a `MessageChannel`
transport and separate target paths. The fixtures create no OS isolation.
`pnpm test:provider` also runs the helper against the real Docker backend. The
provider's [contract-test guide][testing] describes the separate provider
obligations.

[testing]: provider-testing.md
