# Pi integration coverage

The optional `/pi-tools` entry connects public Pi operation hooks to the shared
sandbox. Pi 1.4.0 supplies tool execution, schemas, rendering, output
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
return errors. No configuration uses the built-in host passthrough provider.

## Covered paths

| Path                          | Public hook                                | Delegated operation                                                        | Evidence and limitations                                                                                                                                                           |
| ----------------------------- | ------------------------------------------ | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model `bash` and `powershell` | Definition factories with `BashOperations` | Shared acquisition, target shell execution, streamed bytes and exit status | Real Pi tests cover allow/deny decisions, nested dispatch, result transforms and tool selection. Pi owns output formatting and temporary files.                                    |
| User shell                    | `user_bash` returning `BashOperations`     | Shared acquisition and the configured/default target shell                 | Real Pi and offline CLI/RPC tests cover context exclusion, cold-start cancellation and provider failures. Literal interactive `!`/`!!` parsing needs separate coverage.            |
| Direct SDK consumers          | `/api` facade                              | Provider operations advertised in capabilities                             | Independent-copy and real Pi tests cover registration, selection, shared lifecycle and fake approval around consumer tools. Direct SDK calls do not invoke Pi tool approval hooks. |

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
this integration. Pi controls that registration and event ordering. This entry
does not provide universal interception or isolate arbitrary extension code.

## Upstream extension-point gaps

File and search tools retain Pi's own execution paths. They are not routed by
this entry. The following boundaries need upstream Pi support before the
framework can claim general target-filesystem routing:

| Path         | Pi 1.4.0 behaviour                                                                 | Required extension point                                                                         |
| ------------ | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Read         | Read-path resolution can check host file existence before custom `ReadOperations`. | Target path resolution must be delegated alongside file operations.                              |
| Write/edit   | The mutation queue resolves host real paths outside custom operations.             | Providers need control over mutation identity and the complete read/transform/write transaction. |
| Edit preview | `renderCall` can read host content to compute a preview before approval.           | Preview reads must use an explicit backend boundary and approval policy.                         |
| List/find    | Path resolution and joins use host path semantics before custom operations.        | A target path resolver must cover roots, home expansion and native separators.                   |
| Grep         | Pi starts host ripgrep even when `GrepOperations` is supplied.                     | A complete search operation hook must replace process execution and context reads.               |
| Shell output | Pi stores full output in host temporary files and publishes those paths.           | An output-storage hook is needed for target-readable full-output references.                     |

### Run the reproductions

The [boundary tests][boundary-tests] call Pi 1.4.0's public factories directly
with recording operations and temporary host files. Run them without model
credentials or a sandbox provider:

```sh
pnpm exec vitest run src/pi-boundaries.test.ts
```

The grep case requires an installed ripgrep. The mutation cases create symlinks.
The local verification used macOS. The Linux CI job includes the same cases.
These tests assert the current upstream limitations, so a future Pi upgrade may
require changes to both the tests and the support table.

| Case         | Reproduction and observed result                                                                                                                                                               |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read         | Read an ASCII-apostrophe path through custom operations, then create a host file with the curly-apostrophe variant. The identical request now reads a different target path.                   |
| Write/edit   | Create a host symlink loop at a path that the target treats as a regular file. Both tools fail with host `ELOOP` before calling any custom operation.                                          |
| List/find    | Supply a target path with the other platform's syntax. The custom operation receives a path resolved with host semantics, including the host drive or workspace prefix.                        |
| Edit preview | Call the edit renderer with complete arguments and `executionStarted: false`. Its preview contains a host sentinel; the supplied target read operation has not run.                            |
| Grep         | Supply target content that differs from a host file. The host-only pattern matches and the target-only pattern does not, despite supplying custom directory and read operations.               |
| Shell output | The [full-output test][shell-tests] emits more than Pi's display limit through custom shell operations. Pi publishes a host temporary-file path, and the test reads the original output there. |

Run the shell-output case through the real Pi runtime:

```sh
pnpm build
pnpm exec vitest run src/pi-tools-integration.test.ts -t 'keeps Pi full-output'
```

[boundary-tests]: ../src/pi-boundaries.test.ts
[shell-tests]: ../src/pi-tools-integration.test.ts

These gaps are upstream work. The framework does not use private Pi imports or
replacement tool algorithms to implement those paths. The [research][research]
records the pinned source investigation.

[research]: research.md

## Explicit outside execution

The [approval service][approval] supports explicit outside execution for Bash
and PowerShell. Omitted execution selection retains the ordinary sandbox route.
The normal destination delegates to Pi's public native shell operations; a
provider-defined destination delegates through the SDK backend contract.

[approval]: approval-execution.md

Pi 1.4.0's native shell operations wait for the shell, then stop tracking its
PID. A background descendant can continue in the original process group after
that shell exits. Framework shutdown does not confirm termination of those
descendants. The native Pi route therefore uses termination scope `none`. SDK
passthrough and provider routes use their declared termination scopes and
independent allocation-disposal contracts.
