# Consumer extension example

The example registers `sandbox_pwd`. It runs `pwd` in the workspace that the
broker selects. The user configures the provider independently of this
extension. The tool works with POSIX passthrough and the [Docker
provider][docker]. A configured provider failure produces a typed error.

[docker]: ../docker/README.md

## Run this checkout

Build the SDK and load the existing example from the repository root.

```sh
pnpm build
pi --no-extensions -e ./packages/sdk/examples/consumer/src/index.ts
```

For a compiled install, run
`pnpm --dir packages/sdk pack --pack-destination /tmp/byos-artifacts` after
building. Install the tarball in the trusted extension's project, outside any
writable sandbox workspace. Pi loads the source example above. Ordinary Node
consumers use the compiled exports from the archive.

## Acquire and execute

The example below uses the target `/consumer` entry point. Pass the live Pi
context and the tool's signal to both acquisition and execution.

```typescript
import { getSandbox } from 'pi-bring-your-own-sandbox/consumer';

const options = signal === undefined ? {} : { signal };
const sandbox = await getSandbox(pi, context, {
  ...options,
  capabilities: ['exec'],
  processKinds: ['argv']
});
const result = await sandbox.exec(
  { kind: 'argv', executable: 'pwd', args: [] },
  options
);
```

The argv request preserves argument boundaries. Working directories and
environment overrides refer to the destination. Use the facade to access target
files. The broker owns the backend lifetime.

Omit the access record to use the configured policy within the provider's
support. Ask for a restriction, a need or a path grant when the tool depends on
it. For example, an offline operation requests
`access: { network: 'prevented' }`. A path grant requires an accessible path
within the configured policy.

Use `negotiateSandbox` with the same requirements to check an option without
allocating. Handle refusal with `isSandboxError`, which recognises typed errors
from independent SDK copies. The [specification][spec] describes process
outcomes and the [API appendix][api] lists the types.

[spec]: ../../docs/specification.md
[api]: ../../docs/api-protocol.md
