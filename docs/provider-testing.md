# Testing a provider

The optional `pi-bring-your-own-sandbox/testing` entry registers reusable Vitest
tests for a provider declaration. Install Vitest 5.0.5 in the provider project.
Production imports from `/api` do not load Vitest. The framework does not
require a second Pi runtime for these tests.

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
| `list`            | A seeded directory, its complete metadata and immediate children. Listing order is ignored.                                                                                                                                                                                                   |
| `find` and `grep` | Queries and complete expected results under the provider's documented search rules. Include exact-limit and truncated results, plus context and matching options where supported.                                                                                                             |
| `cancellation`    | A long-running job and a stdout readiness marker. Promised termination scopes also require an independent `verifyStopped` callback. Emit the marker after the processes under test have started.                                                                                              |
| `verifyPolicy`    | Independent negative tests for all requested restrictions. Required for read-only, workspace-only and denied-network scenarios. The callback receives the backend and a deadline context.                                                                                                     |
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
contexts use the selected disposal timeout. `timeoutMs` still bounds the whole
test case, so allow enough time for the cancellation probe to start and, when
termination is promised, stop. A promised termination scope must acknowledge
cancellation within the selected cleanup grace. Scope `none` returns without
waiting for an acknowledgement. A timeout does not establish that a target
stopped. Independent fixture cleanup must release resources even when opening
fails or a transport stops responding. If fixture setup fails before returning,
the setup callback must clean up its partial allocation.

The suite runs teardown after a failed assertion or metadata check. If teardown
also fails, an `AggregateError` preserves the original failure and the cleanup
failures. Fixture resources must be independent between cases. Do not combine
these scenarios with concurrent tests that reuse the same allocation.

## Verify effects at the target

Provider contexts expose synchronous `reportDiagnostic` for warnings outside
workload output. Verify that warnings do not enter expected stdout or stderr.
Use warnings for user-facing runtime information; do not report credentials or
raw provider configuration. Invalid, oversized and excess diagnostics are
discarded and counted in status, while reports after completion are ignored.

Do not use the provider's reported policy as evidence that isolation works. For
a workspace-only policy, attempt an outside-workspace read and write through
both exec and file methods, then check the sentinel files independently. For a
denied-network policy, attempt a controlled connection and check the connection
result. For a read-only policy, attempt mutations and verify unchanged target
contents. Include symlink escapes in runtime-specific tests.

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

The repository runs the common execution, shell and cancellation cases against
two deterministic providers. One records direct calls and maintains an in-memory
workspace. The other sends requests, byte output, cancellation and disposal
acknowledgements through a `MessageChannel` and uses separate target paths. Its
execution-only backend also checks that file groups remain optional. Both are
test doubles without OS isolation.

The host scenario uses real processes, files, fd and ripgrep, and loads the
compiled `/testing` entry. The host scenario does not establish sandbox
isolation. An isolating provider also needs tests for its runtime-specific
boundaries, environment inheritance, allocation identity and recovery behaviour.

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
