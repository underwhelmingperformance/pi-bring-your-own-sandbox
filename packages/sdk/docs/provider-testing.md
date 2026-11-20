# Testing a provider

The optional `pi-bring-your-own-sandbox/testing` entry registers reusable Vitest
tests for a provider declaration. Install Vitest 5.1.0 in the provider project.
Vitest 5.0.5 is also supported. Production imports from `/api` do not load
Vitest. The framework does not require a second Pi runtime for these tests.

Call the suite at test-module scope:

```typescript
import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';

import { provider } from './provider.js';
import { createFixture } from './provider-fixture.js';

defineSandboxProviderTests({
  label: 'remote provider with a writable workspace and denied network',
  provider,
  capabilities: {
    processKinds: ['argv', 'shell'],
    exitStatus: 'guaranteed',
    terminationScope: 'workload',
    operations: ['exec', 'files.read', 'files.write', 'files.list'],
    shells: ['sh']
  },
  createFixture,
  timeoutMs: 30_000,
  cleanup: { cancellationGraceMs: 8000, disposalTimeoutMs: 15_000 }
});
```

`capabilities` selects the operation groups and shells for this scenario. The
default is the provider declaration. Opening must return every selected
capability. Backend metadata is validated against the full declaration even when
the scenario selects fewer capabilities. Register separate scenarios for
different policies and backend capability subsets.

Shell-only scenarios omit `processes` and supply a probe for each advertised
dialect. Optional-status scenarios can expect `{ kind: "unavailable" }` in a
process probe. Termination and disposal still require independent verification.

Each test calls `createFixture`, validates its unknown configuration through the
provider, opens a fresh backend, runs its checks and disposes the backend. The
fixture supplies a host workspace, required policy and target probes. Target
paths can differ from host paths and use the target's path flavour.

The disposal case makes overlapping calls, verifies release independently, then
disposes again during teardown. Providers must share cleanup across repeated
calls, including when cleanup is already complete.

| Fixture member    | What to supply                                                                                                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `processes`       | At least one argv invocation with complete expected stdout, stderr and exit status. Include non-zero exits, empty arguments, quotes, whitespace, newlines, Unicode, shell metacharacters, target executable lookup, cwd changes and environment overrides, including variable deletion.       |
| `shells`          | One invocation for every selected shell dialect, with complete expected output and exit status.                                                                                                                                                                                               |
| `read`            | A seeded regular file, its complete bytes and a path that does not exist.                                                                                                                                                                                                                     |
| `write`           | A missing directory and file for a writable scenario, plus an independent callback that reads the resulting target file. The suite creates parents, writes binary bytes and overwrites the file with shorter content. A read-only scenario must reject a write with a typed permission error. |
| `list`            | A seeded directory, its complete metadata and immediate children. Use a callback to observe directory size on the target after opening. Listing order is ignored.                                                                                                                             |
| `find` and `grep` | Queries and complete expected results under the provider's documented search rules. Include exact-limit and truncated results, plus context and matching options where supported.                                                                                                             |
| `cancellation`    | A long-running job and a stdout readiness marker. Promised termination scopes also require an independent `verifyStopped` callback. Emit the marker after the processes under test have started.                                                                                              |
| `verifyPolicy`    | Independent negative tests for all requested restrictions. Required for read-only, workspace-only, system-read-only, denied-network and protected-resource scenarios. The callback receives the backend and a deadline context.                                                               |
| `verifyDisposed`  | An independent check that generation-owned resources have been released after disposal resolves.                                                                                                                                                                                              |
| `cleanup`         | Unconditional fixture teardown, including recovery from failed opening or disposal.                                                                                                                                                                                                           |

The suite requires probes for every selected capability. Configuration errors,
missing methods, inconsistent capabilities, unsupported effective policies,
incorrect output and unconfirmed cancellation within a promised scope fail the
tests. Typed errors are recognised across separately installed SDK copies.

Opening, each test case and fixture cleanup receive separate `timeoutMs`
deadlines, with a default of ten seconds per stage. The `cleanup` option selects
`cancellationGraceMs` and `disposalTimeoutMs` independently, with defaults of
five and ten seconds. Each cleanup budget must be an integer from 1 to 300,000
milliseconds. Cancellation contexts publish the selected grace, and disposal
contexts use the selected disposal timeout. When a case exceeds its foreground
deadline, the suite waits up to the cancellation grace period before disposal. A
promised termination scope must acknowledge cancellation within the selected
cleanup grace. Scope `none` returns without waiting for an acknowledgement. A
timeout does not establish that a target stopped. Independent fixture cleanup
must release resources even when opening fails or a transport stops responding.
If fixture setup fails before returning, the setup callback must clean up its
partial allocation.

The suite runs teardown after a failed assertion or metadata check. If teardown
also fails, an `AggregateError` preserves the original failure and the cleanup
failures. Fixture resources must be independent between cases. Do not combine
these scenarios with concurrent tests that reuse the same allocation.

Set `workspaceVisibility` to `shared` or `copied` to register the corresponding
visibility scenario. Its `visibility` probe reads and atomically replaces a
seeded source file and constructs target commands for the same file. In a
writable shared workspace, the test observes a target write from the source
while the writer is running, then replaces the file and waits for the writer to
observe the replacement. Copied workspaces must isolate changes in both
directions. When file methods are available the suite also compares their
results with target process reads and independent source reads.

Supply `visibility.stageSave` to test an editor that replaces a file by rename.
The first target command writes a temporary file. The suite replaces the source
file on the host before the second target command renames the temporary file.
Independent reads check the final contents on both sides. The editor's save wins
in a shared workspace. In a copied workspace the host keeps its own edit.
Fixture cleanup must include the temporary file if the scenario ends before the
rename.

In writable scenarios, grep searches the file at `visibility.targetPath` after a
target process writes to the copy or the host replaces the shared file. It
searches again after a file write. Supply an absent, searchable path under
`visibility.findTarget` to check whether find sees a newly created file. The
fixture controls the path so it can account for the provider's ignore rules. The
suite reads the copied workspace's source file again after disposal.

## Verify effects at the target

Provider contexts expose synchronous `reportDiagnostic` for warnings outside
workload output. Verify that warnings do not enter expected stdout or stderr.
Use warnings for user-facing runtime information; do not report credentials or
raw provider configuration. Invalid, oversized and excess diagnostics are
discarded and counted in status, while reports after completion are ignored.

Do not use the provider's reported policy as evidence that isolation works. For
a workspace-only policy, attempt an outside-workspace read and write through
both exec and file methods, then check the sentinel files independently. For a
denied-network policy, attempt controlled connections and use an independent
listener to check whether traffic arrived. For a read-only policy, attempt
mutations and verify unchanged target contents. Include symlink escapes in
runtime-specific tests. Probe pathname Unix sockets through read-only mounts,
grants and aliases, abstract sockets and host resolver services. Denied
networking includes relays through host services. Network namespaces and
read-only mounts alone do not establish socket denial. A provider must reject
restrictions that it cannot enforce.

For `process-group` and `workload`, `verifyStopped` must independently establish
termination within the advertised scope. Include a waiting parent with a child
that creates another session in runtime-specific tests. A workload provider must
stop that child; a process-group provider may leave it running with the same
access restrictions. Fixture cleanup must independently stop surviving children.
For `none`, omit `verifyStopped`; the suite requests cancellation and verifies
`not-guaranteed` without waiting for termination. A transport promise rejecting,
or the backend returning a confirmed result, is insufficient evidence.
`verifyDisposed` should inspect allocations through the runtime's management
interface or another independent observer.

Set `verifyRecoveryAfterCancellation: true` and supply a successful process
probe under `cancellation.after` to verify continued use. The suite runs the
probe on the same allocation after the independent termination check.

In-memory and message-based test doubles verify protocol behaviour, not OS
isolation. Real host execution also does not establish sandbox isolation. An
isolating provider needs tests for its runtime-specific boundaries, environment
inheritance, allocation identity and recovery behaviour.

For an internal shell transport, run the argv probes through the actual runtime
transport. Verify that shell builtins and assignment-like executable names use
ordinary target executable lookup. Supply hostile startup variables, such as
`BASH_ENV` or `ENV` for POSIX shells, and a `PATH` containing a substitute
shell. Check independently that startup code did not execute, that overrides
reached only the target, and that stdout and stderr contain only target output.
Include runtime-specific loader and startup hooks in these checks.

Add negative execution cases alongside the common suite. A missing executable
and a missing working directory must produce typed operation errors. A target
that starts and exits with code 127 must return an ordinary exit result. The
repository's `src/argv-conformance.test.ts` compares direct execution with a
small real shell transport fixture. That fixture tests encoding and bootstrap
separation; it does not establish any external runtime's cancellation or
isolation guarantees.

Protected-resource scenarios also need the independent mutation probes specified
in [workspace protection][workspace-protection]. The test kit requires the
probe; it cannot establish runtime enforcement from a capability declaration.

[workspace-protection]: workspace-protection.md

Set `verifyIndependentAllocations: true` to check two allocations from the same
source. Supply a repeatable `peerProcess` probe. The suite checks its output and
exit status on the second allocation before and after disposing the first. The
fixture must implement `verifyAllocationDisposed(backend)` to check the first
allocation against the runtime while the second allocation is still open.
Fixture cleanup must account for both allocations.

Use `verifyConcurrentCancellation` for providers that support concurrent jobs
and confirmed termination. Supply a `concurrentJob` that emits a ready marker
and waits. The suite cancels a second job on the same allocation, then sends
fresh bytes through the fixture's independent `release` callback. The callback
receives the operation context so it can stop at the scenario deadline. The
waiting job must return those bytes and exit successfully.

## Checking policy effects

Select individual cases with `policyEffects`. Each case gets a fresh allocation.
Supply a fixture function under the same key in `fixture.policyEffects`. The
function receives the open backend so the fixture can identify the allocation
and introduce resources after startup.

| Case                | Independent observation                                                                                                                                               |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `read-only`         | Read the protected bytes, mode and link count from the backing workspace, or confirm that a protected path remains absent.                                            |
| `protected-path`    | Observe the protected resource while the target attempts a direct mutation.                                                                                           |
| `protected-alias`   | Direct the mutation at an alias and observe the original protected resource.                                                                                          |
| `late-special-file` | Create a socket or FIFO after opening. Use an independent client to connect to the socket or write bytes to the FIFO. Return the cumulative connection or byte count. |
| `denied-network`    | Connect an independent control client to the listener before the target attempts a connection. Return the listener's cumulative connection count.                     |

Supply a permitted process, a denied process and an `observe` function. The
suite checks both process outcomes and compares independent observations before
and after each denial. With guaranteed exit status the permitted process must
exit successfully and the denied process must exit with a positive error code.
When the backend provides file operations, supply the target path and expected
error for a write, or for a read of a late special file. Use `absent` if the
target cannot see the path and `denied` for a permission error. A read of a
special file can also specify `unsupported-file` for `SandboxOperationError`.
Inspect the backing resource directly through the fixture. Reading it through
the backend would test the same boundary twice.
