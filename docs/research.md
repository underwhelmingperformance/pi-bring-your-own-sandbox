# Pi extension research

Investigated on 30 October 2026. This document distinguishes verified Pi
behaviour from the proposed framework in the [specification][spec].

[spec]: specification.md

## Starting point and versions

The final answer in the [shared conversation][conversation] proposes three
components: a shared SDK, a broker extension and provider extensions. Consumer
extensions use the SDK without depending on a particular sandbox implementation.
The conversation also distinguishes cooperative tool execution from confinement
of extension code. Those are the requirements used for this design.

This checkout initially contained only `.git`, with no commits, package
manifest, runtime configuration or tests. The installed `pi --version` reports
`1.4.0`. The official repository's `main` resolved to
`0441483926f283e42ca44eb7b4a46552e9469d6f`, committed at `2026-10-30T11:23:48Z`.
Its coding-agent package also specifies `1.4.0`. Source references below use
that immutable revision.

The installed command is a Nix wrapper. Its bundled documentation was useful for
comparison; the source snapshot and a temporary installation of the published
`@earendil-works/pi-coding-agent@1.4.0` supplied the API and runtime evidence.
Node `24.22.2` ran the probes. The checkout's Node/npm shims had no selected
version, so the probes used an existing Node installation by absolute path.

[conversation]: https://chatgpt.com/share/6ae48d69-6518-83ed-9edf-0dc2d90ed01f

## Writing and distributing extensions

An extension exports a default factory with an `ExtensionAPI` argument. The
factory registers tools, commands and lifecycle handlers. Long-lived resources
should start in a lifecycle handler or on demand. A factory must not wait for
another extension's lifecycle handler.

Pi loads TypeScript through Jiti, with mappings for host packages. An ordinary
npm package can declare its extension files in `package.json` under
`pi.extensions`. Runtime dependencies belong in `dependencies`; Pi's own
packages and `typebox` are host-provided peers. The current package guidance
requests `"*"` peer ranges and prohibits bundling private copies of those host
packages. Separate extension installations have separate dependency roots, so a
shared SDK cannot assume one module instance.

Use `pi -e ./path/to/extension.ts` for a temporary invocation. Project-local
`.pi/extensions/` and global extensions support normal discovery and `/reload`.
Project resources require Pi's project trust. Installing an SDK as another
package's dependency does not by itself load a broker extension.

The current design accounts for that distinction by having SDK acquisition
initialise a shared broker service on demand. The optional broker extension
provides diagnostics and early registration, but a consumer's SDK dependency
must be sufficient for default host execution. This is a proposed framework
behaviour to verify in integration tests, not automatic extension loading by Pi.

Sources: [extension documentation][extensions], [package
documentation][packages] and [loader][loader].

[extensions]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/docs/extensions.md
[packages]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/docs/packages.md
[loader]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/extensions/loader.ts

## API findings that affect the design

| Pi facility                     | Verified behaviour                                                                                                                                                                                  | Design consequence                                                                                                                          |
| ------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `pi.events`                     | String channels exchange arbitrary in-process values, including callbacks and service objects. `emit()` returns `void`. Listener failures are caught and logged. Async listeners are not awaited.   | Use synchronous discovery replies and explicit promise-returning service methods. Never infer registration success from `emit()` returning. |
| Extension factories             | Pi can reuse imported factories while constructing fresh extension APIs. Module variables can therefore be shared across sessions.                                                                  | Scope broker/provider state to one live Pi runtime. No module-level registry, `globalThis` registry or singleton SDK state.                 |
| Lifecycle                       | `session_start` includes startup, reload, new, resume and fork. `session_shutdown` precedes normal runtime replacement and reload.                                                                  | Bind resources to one runtime generation and recreate them after replacement.                                                               |
| Reload                          | Pi emits shutdown, invalidates the old runtime, reloads resources and emits start. Extension-owned event-bus subscriptions are removed on invalidation.                                             | Dispose backend resources explicitly; also reject cached handles from the old generation.                                                   |
| `AgentSession.dispose()`        | Invalidates the extension runtime and aborts work, but does not emit `session_shutdown`.                                                                                                            | Bare SDK hosts need an explicit asynchronous close before disposal.                                                                         |
| `AgentSessionRuntime.dispose()` | Aborts work, emits shutdown and then disposes the session.                                                                                                                                          | Prefer this lifecycle in embedding hosts and lifecycle integration tests.                                                                   |
| Lifecycle handler errors        | The general event runner reports errors and continues.                                                                                                                                              | A failed startup handler alone cannot enforce failure. Store failure state and check every operation.                                       |
| `pi.registerTool()`             | A matching extension tool replaces a built-in. The first extension registration wins if several extensions register the same tool.                                                                  | Check effective tool ownership and report conflicts. Do not depend on a later override winning.                                             |
| `ctx.executeTool()`             | Available in `ExtensionToolContext`; nested calls use validation, tool hooks and execution events. Tool failures return an outcome with `isError: true`. The tool result is under `outcome.result`. | Consumers inside tools can reuse routed Pi tools. SDK calls from commands and events need the broker API.                                   |
| `user_bash`                     | The first handler returning `{ operations }` or `{ result }` handles the command. `undefined` permits the next handler or local execution. Handler failure blocks execution.                        | Return routed operations or fail. Another earlier shell handler can prevent the broker's handler from running.                              |
| `pi.exec()`                     | Calls the local process runner directly.                                                                                                                                                            | Replacing `bash` does not redirect `pi.exec()` or arbitrary Node process calls.                                                             |

Sources: [event bus][bus], [extension types][types], [event runner][runner],
[session implementation][session], [session runtime][runtime] and the
[factory-cache][factory-test] and [event-bus lifecycle][bus-test] regressions.

[bus]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/event-bus.ts
[types]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/extensions/types.ts
[runner]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/extensions/runner.ts
[session]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/agent-session.ts
[runtime]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/agent-session-runtime.ts
[factory-test]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/test/suite/regressions/extension-factory-cache.test.ts
[bus-test]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/test/suite/regressions/7193-event-bus-lifecycle.test.ts

## Tool backends are useful but not a complete remote filesystem abstraction

The [Gondolin example][gondolin] demonstrates VM-backed shell, file and search
tools. The [sandbox example][sandbox-example] demonstrates shell routing through
Anthropic's sandbox runtime. Both are useful integration examples, but neither
defines an interchangeable service for other providers.

| Tool                  | Relevant implementation constraint                                                                                                                                                                                                                     |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `bash`, `powershell`  | `BashOperations.exec()` receives combined byte output callbacks, optional environment and cancellation, and timeout in seconds. `PowerShellOperations` is an alias for `BashOperations`; the provider must still support the requested shell language. |
| `read`                | Operations replace access and file reads, but path resolution can probe host file existence before calling operations. A complete backend boundary needs an upstream path-resolution hook.                                                             |
| `write`, `edit`, `ls` | Write/edit use a host-realpath mutation queue outside custom operations. Edit call rendering can also read host files for a preview. These require upstream hooks.                                                                                     |
| `find`                | Custom `glob()` replaces the search, but path resolution still uses Pi host helpers. A complete boundary needs an upstream hook.                                                                                                                       |
| `grep`                | `GrepOperations` replaces directory checks and context reads only. The implementation still starts host `rg`. This framework leaves that path unsupported until Pi provides a complete search hook.                                                    |
| Shell output          | Pi's shell tools and user-shell executor can spool truncated output into host temporary files. A sandbox cannot necessarily read those paths.                                                                                                          |

The framework should keep Pi tool adaptation separate from its provider API. In
particular, a generic provider must not have to implement Node `ChildProcess`,
Pi tool-result formatting or host filesystem methods.

Sources: [shell implementation][bash-source], [read path resolution][paths],
[find implementation][find-source], [grep implementation][grep-source], [output
accumulator][output] and [user-shell executor][user-shell].

[gondolin]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/examples/extensions/gondolin/index.ts
[sandbox-example]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/examples/extensions/sandbox/index.ts
[bash-source]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/tools/bash.ts
[paths]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/tools/path-utils.ts
[find-source]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/tools/find.ts
[grep-source]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/tools/grep.ts
[output]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/tools/output-accumulator.ts
[user-shell]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/src/core/bash-executor.ts

## Testing extensions

Pi uses Vitest. Its [SDK documentation][sdk] explains `DefaultResourceLoader`,
inline extension factories, `createAgentSession()`, `bindExtensions()` and
in-memory session/settings managers. Its [test harness][harness] scripts model
responses with a faux model provider. This permits real tool dispatch and hooks
without external model calls. The upstream harness is test code, not a public
package export; this project needs its own small harness using public APIs.

Three test levels are appropriate: framework unit tests, published-SDK
integration tests, and packaged-extension/real-provider smoke tests. A mocked
`ExtensionAPI` alone cannot establish loader, tool-dispatch or reload behaviour.
Calling a wrapped tool's `execute()` directly also does not reproduce a real
nested call: the nested dispatcher requires an issuing assistant message.

[sdk]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/docs/sdk.md
[harness]:
  https://github.com/earendil-works/pi/blob/0441483926f283e42ca44eb7b4a46552e9469d6f/packages/coding-agent/test/suite/harness.ts

## Exploratory results

A temporary npm installation of Pi 1.4.0, installed with lifecycle scripts
disabled, ran a Node assertion script outside this repository. A faux model
issued an outer consumer tool call; that tool called
`ctx.executeTool("read", ...)`. Both broker-first and consumer-first factory
orders passed these checks:

- The nested read returned bytes from custom operations for a nonexistent local
  file, and the nested `tool_call` event included its parent relationship.
- The `user_bash` handler supplied custom operations, and the session shell
  executor returned their output.
- Reload emitted one shutdown and a second start, removed the old event listener
  and rejected access through the old extension API.
- Raw `session.dispose()` did not emit another shutdown.

A separate check showed that async event-bus work continued after `emit()`
returned. Two independent resource loaders also kept their event-bus listeners
separate. The probes used temporary agent directories and no real credentials or
external model calls. They verified Pi integration primitives, not a framework
implementation, operating-system isolation or a remote provider.

The shell probe explicitly dispatches `user_bash` and passes its operations to
the SDK executor. Automated tests also start the bundled CLI in offline RPC mode
with an explicit TypeScript extension and temporary agent configuration. Tests
cover normal and context-excluded commands, cold-start cancellation through
`abort_bash`, and a later command after shared startup completes. Real Pi
sessions with a scripted model separately verify exclusion from model input. The
interactive `!` and `!!` input parser and real-provider execution need separate
coverage.

Pi 1.4.0's `executeBashWithOperations` suppresses operation errors when the user
shell's abort signal is set and returns `cancelled: true`. A real-Pi test
confirms that an unconfirmed provider stop still quarantines the broker and
prevents later execution. The Pi user-shell result does not contain the SDK
completion state.

## Related implementation

[Landstrip's API][landstrip] demonstrates versioned event channels, callback
discovery and a public cross-extension module. The repository's `main` resolved
to `059874ba05222ed120a63eb1aa9581612b3319d0` during this investigation. Its
process preparation and policy model belong to Landstrip. The proposed framework
should use the general discovery pattern without adopting Landstrip-specific
launchers or treating missing discovery as permission for host execution. This
investigation does not establish that no other generic sandbox framework exists.

[landstrip]:
  https://github.com/landstrip/landstrip/blob/059874ba05222ed120a63eb1aa9581612b3319d0/packages/pi-landstrip/api.ts

## Native host search

The host backend uses fd for glob matching and ripgrep for line matching. Native
tests cover ignore rules, limits, context and directory markers. These tests
validate the host provider; they do not establish Pi tool compatibility. The
local tools were fd 10.5.0 and ripgrep 15.2.0. CI installs its search test tools
from Ubuntu's package repositories.

Ripgrep's [JSON protocol][rg-json] reports binary detection in the file's `end`
record. A local probe emitted an initial text match before detecting a NUL byte
140,006 bytes into the file. The backend therefore keeps each file's candidate
matches until that record, then discards binary matches. A single search thread
keeps file records consecutive. Incremental collectors drain all tool output and
retain candidates according to the requested result limit and context. They do
not stop the process when the limit is reached.

[rg-json]: https://docs.rs/grep-printer/0.3.1/grep_printer/struct.JSON.html
