# pi-bring-your-own-sandbox

A shared sandbox API for Pi extensions. Provider extensions supply execution
environments, and consumer extensions use them without depending on a specific
sandbox implementation.

Users choose a sandbox separately from installing a consumer extension. With no
configuration, the SDK uses host passthrough. Once a provider is selected,
consumers use it automatically. A configured provider failure returns an error.

This is a cooperative framework: only operations sent through its API use the
selected sandbox. The package is currently a private development build for Pi
1.5.0.

## Use the SDK in an extension

Follow the [consumer guide][consumer] to build, install and try the package from
this checkout. Add it as a normal dependency of your extension.

Inside a Pi tool's execution callback, acquire the shared sandbox with the live
context and cancellation signal:

```typescript
import { getSandbox } from 'pi-bring-your-own-sandbox/api';

const options = signal === undefined ? {} : { signal };
const sandbox = await getSandbox(pi, context, options);
const result = await sandbox.exec(
  { kind: 'argv', executable: 'pwd', args: [] },
  options
);
```

Commands and paths refer to the target environment. The consumer guide explains
results, capabilities, errors and cleanup.

To supply a sandbox, start with the [Docker provider example][docker]. The
[provider testing guide][testing] explains how to check a provider against the
shared contract.

[consumer]: examples/consumer/README.md
[docker]: examples/docker/README.md
[testing]: docs/provider-testing.md

## Choose where commands run

Load a provider extension and select it in your personal agent directory's
`byos.json`. Follow the provider's setup instructions; the Docker example
includes a complete configuration.

To route Pi's Bash, PowerShell and user-shell commands through the framework,
create `.pi/extensions/sandbox-tools.ts`:

```typescript
export { default } from 'pi-bring-your-own-sandbox/pi-tools';
```

Pi's file and search tools retain their own execution paths. See the [Pi
integration guide][integration] for supported hooks and limits.

Extensions can also request execution outside the sandbox. By default, these
requests use the environment that Pi would ordinarily use and ask the user for
approval. Users can select a different approval policy or a provider-defined
outside environment independently. See [approvals and outside
execution][approvals] for configuration and examples.

[integration]: docs/pi-integration.md
[approvals]: docs/approval-execution.md

## Development

Use the Node and pnpm versions pinned in this repository:

```sh
pnpm install --frozen-lockfile
pre-commit install
pnpm check
```

The [development and validation guide][validation] lists prerequisites, test
commands and coverage. The [specification][spec] describes the design and links
to the API reference.

[validation]: docs/validation.md
[spec]: docs/specification.md
