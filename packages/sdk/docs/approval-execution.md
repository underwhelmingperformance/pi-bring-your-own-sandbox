# Approval and execution outside the sandbox

Approval policies and execution providers are independently selected services.
An extension can supply either service or both. Approval policy registration
does not select an approval policy. The framework includes the `user`, `always`
and `never` approval policies; an unconfigured user gets `user`.

## Extension-owned settings

Register independent callbacks during extension loading:

```typescript
import {
  configureExecutionApproval,
  configureOutsideExecution
} from 'pi-bring-your-own-sandbox/api';

configureExecutionApproval(pi, () => ({ policy: 'user' }));
configureOutsideExecution(pi, () => ({ destination: 'normal' }));
```

`config` in the approval selection contains policy-specific input. Its validator
receives that input unchanged; an omitted value becomes an empty object.
Built-in policies accept an empty object only. Unknown policy IDs, invalid
configuration and duplicate registrations produce errors.

`normal` is the default outside destination. SDK calls use the normal
passthrough backend. Pi Bash and PowerShell calls use Pi's public normal shell
operations. An embedding host can provide another normal environment through
`initialiseSandboxHost` and its `normalExecutor` option.

`provider` selects the ordinary sandbox provider's optional `outsideSandbox`
declaration. This can provide, for example, execution on the same remote machine
with different restrictions. The provider validates its extension-owned
configuration and allocates this destination separately from its ordinary
sandbox.

Configuration is fixed for a runtime generation. Reload to apply changes.

## SDK calls

Acquire the destination before constructing commands that depend on its paths:

```ts
import { getOutsideSandboxExecutor } from 'pi-bring-your-own-sandbox/api';

const executor = await getOutsideSandboxExecutor(pi, context, { signal });
const result = await executor.exec(
  {
    kind: 'argv',
    executable: 'git',
    args: ['status', '--short'],
    cwd: executor.destination.workspace.root
  },
  {
    justification: 'Inspect changes in the normal execution environment.',
    signal,
    timeoutMs: 30_000
  }
);
```

The facade provides process execution and immutable destination and capability
metadata. Commands, working directories and environment overrides use the
destination's semantics. The framework does not translate paths or synchronise
files between destinations.

Acquisition defaults to 60 seconds. Each `exec` defaults to 120 seconds,
including approval. Approval allows at most 60 seconds or the remaining
execution budget. Cancellation, shutdown and expiry prevent a pending decision
from starting execution. SDK streaming, capture limits, declared termination
scope and recovery use the process contract.

The broker snapshots each request, obtains a decision and executes that same
request on that same destination. Every call requires a fresh decision. This
release provides no reusable grants or approval cache.

Explicit outside execution does not require starting the ordinary sandbox.
Ordinary sandbox failures do not request outside execution. A missing outside
capability, failed allocation, policy failure or failed execution produces an
error; the framework does not change destinations or retry the operation.

## Approval policies

`registerApprovalPolicy(pi, policy)` registers a declaration during an extension
factory. The declaration specifies `id`, `label`, `protocolVersion: 1`, a
synchronous `validateConfig` and asynchronous `decide` method.

The decision method receives an immutable `ExecutionApprovalRequest`, an
`ApprovalContext` and validated configuration. The request contains the process,
resolved destination and non-empty justification. The context supplies the live
Pi context, operation ID, cancellation signal and absolute deadline. Return
`{ kind: "allow" }` or `{ kind: "deny" }`. Respect cancellation and return
before the deadline. A justification is a request for permission, not evidence
that permission has already been granted.

The built-in policies behave as follows:

| Policy   | Behaviour                                                                   |
| -------- | --------------------------------------------------------------------------- |
| `user`   | Show the operation, destination and justification through Pi's dialogue UI. |
| `always` | Allow every valid approval request.                                         |
| `never`  | Deny every valid approval request.                                          |

The user dialogue shows explicit environment override keys without displaying
their values. It does not display the inherited environment. Dialogues are
serialised per runtime; queued requests retain their deadlines. An unavailable
UI, dismissal, cancellation, timeout or invalid policy response never allows
execution. Pi reports dialogue dismissal and dialogue timeout as negative
confirmations. Expiry of the operation deadline uses `SandboxTimeoutError`. Pi
supports confirmation dialogues in interactive and RPC modes.

`requestExecutionApproval(pi, context, request, options?)` exposes the same
service to extensions that implement process execution themselves. It returns a
decision and starts no process or sandbox. A returned decision is not a
transferable grant for a later broker call. The framework does not include an
automatic reviewer model; a separate extension can implement one.

Approval failures use concrete `ApprovalError` subclasses. Use `isApprovalError`
for errors from another installed SDK copy. Cancellation and deadline failures
use the existing sandbox error classes. A failed policy or missing configured
policy never selects `always`.

## Providers and Pi tools

A provider's optional `outsideSandbox` declaration specifies `label`,
`capabilities`, `policy` and `open`. Its open method receives the same validated
provider configuration and allocation context as an ordinary provider. It
returns a backend with process execution and cleanup; file and search groups
remain optional. The declared policy describes required protections for this
destination and is checked before publication. Providers enforce their
advertised restrictions.

The framework owns approval and dispatch. An execution provider cannot select
the approval policy. An extension that implements both services registers each
service explicitly; configuration callbacks select them independently.

The optional `/pi-tools` entry adds `execution` and `justification` arguments to
Pi's Bash and PowerShell definitions. `execution` defaults to `sandbox`; use
`outside-sandbox` with a non-empty justification to request outside execution.
Approval sees the command after Pi applies its configured command prefix. Pi
continues to own validation, tool hooks, execution presentation and full-output
storage. The `user_bash` integration continues to use the selected sandbox.

`closeSandboxSession` cancels pending reviews and closes ordinary and outside
execution resources. Pi shutdown performs the corresponding lifecycle cleanup.
Old handles cannot execute after shutdown or reload. A runtime-wide close
barrier also prevents new approval or execution services after explicit SDK
shutdown.

Pi's native outside-shell operations use termination scope `none`. A normal
result reports the shell's completion, while cancellation returns without a
termination acknowledgement and reports `not-guaranteed` completion. Processes
may continue running after cancellation. SDK outside execution and injected
normal executors use their backend's declared scope, which consumers can require
during acquisition. Framework allocation disposal remains a separate obligation.
The framework delegates native shell execution to Pi.

`/byos status` reports the selected approval policy and outside destination;
`/byos approval-policies` enumerates registered policies. Diagnostics do not
allocate an execution backend or display policy-specific configuration.

This remains a cooperative extension framework. Extensions that perform direct
Node or Pi I/O do not acquire a framework approval automatically.
