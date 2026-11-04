# Pi integration

The optional `/pi-tools` entry connects public Pi operation hooks to the shared
sandbox. Pi 1.5.0 supplies tool execution, schemas, rendering, output
accumulation and transcript files. The framework supplies command execution
through `BashOperations` and the `user_bash` event.

Load the entry explicitly from a project extension:

```typescript
export { default } from 'pi-bring-your-own-sandbox/pi-tools';
```

The package's default extension remains diagnostics only. Loading `/pi-tools`
preserves the active tool selection, including explicit allowlists and default
tool modifiers. Bash uses the `bash` target dialect and PowerShell uses
`powershell`; user shell commands use configured `userShell` or the provider's
advertised default. Unsupported target dialects and selected-provider failures
return errors. Without configuration, the SDK uses the built-in host passthrough
provider.

## Supported execution paths

| Path                      | Integration                                                |
| ------------------------- | ---------------------------------------------------------- |
| Model Bash and PowerShell | Pi definition factories use SDK-backed `BashOperations`.   |
| User shell                | `user_bash` supplies SDK-backed `BashOperations`.          |
| Direct SDK consumers      | `/api` exposes the provider's advertised operation groups. |

Pi owns tool validation, approval hooks, rendering and output storage. Direct
SDK calls do not invoke Pi tool approval hooks.

Bash preserves Pi's configured `shellCommandPrefix` through the public settings
and definition APIs. The prefix executes in the target shell. An explicit tool
`timeout` includes startup and execution. When omitted, the SDK allows 60
seconds for startup and 120 seconds for execution; the tool schema describes
those limits. Unconfirmed termination retains deadline classification and
unknown completion.

SDK execution does not inherit the host environment supplied to
`BashOperations`. The provider supplies target defaults and the SDK enforces
capabilities, cancellation and completion semantics. Pi full-output references
refer to host transcript files. A remote sandbox may not be able to read those
files. The integration does not copy transcript files into the target or create
its own output accumulator.

`/byos status` reports whether a loaded shell integration factory answered its
diagnostic query. Routing remains unverified: Pi exposes no public way to
enumerate competing `user_bash` handlers or guarantee that this integration
receives every command. Loading the factory does not establish universal
interception. An unrecognised diagnostic reply reports request status as
unavailable.

Other extensions can replace the shell definitions or consume `user_bash` before
this integration. Pi controls registration and event ordering. Restricting Pi,
its extensions and local MCP servers requires an [outer sandbox][outer-runtime].
Remote MCP servers run under their own host's security policy.

[outer-runtime]: outer-runtime.md

## Upstream extension-point gaps

File and search tools retain Pi's own execution paths. They are not routed by
this entry. The following boundaries need upstream Pi support before the
framework can claim general target-filesystem routing:

| Path         | Pi 1.5.0 behaviour                                                                 | Required extension point                                                                         |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Read         | Read-path resolution can check host file existence before custom `ReadOperations`. | Target path resolution must be delegated alongside file operations.                              |
| Write/edit   | The mutation queue resolves host real paths outside custom operations.             | Providers need control over mutation identity and the complete read/transform/write transaction. |
| Edit preview | `renderCall` can read host content to compute a preview before approval.           | Preview reads must use an explicit backend boundary and approval policy.                         |
| List/find    | Path resolution and joins use host path semantics before custom operations.        | A target path resolver must cover roots, home expansion and native separators.                   |
| Grep         | Pi starts host ripgrep even when `GrepOperations` is supplied.                     | A complete search operation hook must replace process execution and context reads.               |
| Shell output | Pi stores full output in host temporary files and publishes those paths.           | An output-storage hook is needed for target-readable full-output references.                     |

These gaps require upstream public hooks. BYOS does not use private Pi imports
or replace Pi's tool algorithms. The [adapter prerequisites][file-adapters]
describe the required hooks. The [boundary tests][boundary-tests] check the
unsupported paths against the installed Pi version.

[file-adapters]: pi-file-adapters.md
[boundary-tests]: ../src/pi-boundaries.test.ts

## Explicit outside execution

The [approval service][approval] supports explicit outside execution for Bash
and PowerShell. Omitted execution selection retains the ordinary sandbox route.
The normal destination delegates to Pi's public native shell operations; a
provider-defined destination delegates through the SDK backend contract.

[approval]: approval-execution.md

Pi 1.5.0's native shell operations wait for the shell, then stop tracking its
PID. A background descendant can continue in the original process group after
that shell exits. Framework shutdown does not confirm termination of those
descendants. The native Pi route therefore uses termination scope `none`. SDK
passthrough and provider routes use their declared termination scopes and
independent allocation-disposal contracts.
