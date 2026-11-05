# Bring-your-own-sandbox specification

This specification defines the shared execution contract for Pi 1.5.0. The [API
and protocol appendix][api] specifies exact layouts, ownership rules and
discovery envelopes alongside the exported TypeScript declarations. Contract
changes must update both documents and the declarations.

The [development guide][validation] describes checks and platform limits. The
[Pi integration guide][pi] defines supported tool routing and upstream gaps.

[api]: api-protocol.md
[validation]: validation.md
[pi]: pi-integration.md

## Purpose and scope

Provide a backend-neutral execution service for cooperating Pi extensions.
Consumer extensions work without installing or configuring a sandbox. The SDK
uses its built-in `passthrough` provider by default; a user can independently
select a provider extension for a local OS sandbox, container, SSH connection or
VM. Consumer code stays the same. No Pi core change is required for this
cooperative API.

The framework has three roles:

1. The SDK defines structural contracts, provider registration and consumer
   discovery. Multiple installed copies of the SDK must interoperate.
2. A shared broker service discovers providers, validates configuration, selects
   one provider and manages that provider's backends for each Pi runtime
   generation, one for each negotiated policy. The SDK creates this service on
   first use if a compatible service is not present.
3. Provider extensions implement backend operations. Consumer extensions obtain
   broker-managed handles and execute operations through them.

Optional Pi integration connects public backend-operation hooks to the service.
Pi remains responsible for tool algorithms, rendering and input handling.
Missing hooks and execution paths that bypass those hooks require upstream Pi
changes. The framework does not replace Pi executors to compensate for those
gaps. Provider extensions can register optional diagnostics through
`registerSandboxDiagnostics`. SDK use does not replace Pi tools.

The framework supports foreground execution with streamed output, cancellation
and deadlines; optional filesystem and search capabilities; session cleanup;
zero-configuration host execution; user-selected sandbox providers; diagnostics;
provider/consumer examples; and tests of the real Pi loader and dispatch path.
The framework does not require a particular production sandbox runtime.

PTYs, interactive stdin, detached jobs, port forwarding, snapshots, automatic
file synchronisation, provider hot-switching and cross-process discovery are
unsupported. The API must reject requirements for those features. Additional
capabilities can be specified in later protocol versions.

## Execution boundary

This is a cooperative execution service. Pi, the broker, providers and consumers
run with the host process's permissions. Direct Node filesystem/process calls,
`pi.exec()`, MCP servers and extensions that do not use this service keep their
existing execution paths. The service does not confine hostile extensions.

Providers are trusted to enforce their advertised policy. SDK capability checks
cannot prove OS isolation. Real-provider tests establish the tested provider's
behaviour on the tested platform, not a guarantee for every provider.

Host execution is the default only when configuration does not select another
provider. An explicitly selected provider that is missing, fails to start or
loses its transport produces an error. Unsupported requirements and permission
denials also produce errors. None of these failures selects `passthrough`.
Malformed or unreadable configuration is an error, not evidence that the user
chose host execution. The framework never retries a failed sandbox operation on
the host or automatically repeats a possibly completed remote operation.

## Packaging and extension author workflow

The `pi-bring-your-own-sandbox` SDK package provides these entry points:

| Entry point | Purpose                                                                                                                              |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/api`      | Provider and consumer types, registration, discovery and typed errors. No broker state or resource allocation on import.             |
| `/pi-tools` | Optional Pi factory for tool routing. Users load this entry explicitly through a local extension or an explicit extension-file path. |
| `/testing`  | Reusable provider contract-test definitions, with Vitest as an optional test peer. Production entry points do not import Vitest.     |

These are subpath exports of the SDK package. The optional
`pi-bring-your-own-sandbox-guard` package provides a separate Pi extension.
External providers and consumers are independently distributed Pi extensions.
The built-in passthrough backend and on-demand broker service are included in
the framework package.

| Package role                | Dependency relationship                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Framework                   | Host-provided Pi packages that it imports are peers. Initially this is `@earendil-works/pi-coding-agent`. Pinned development dependencies supply the host APIs for type checking and tests. |
| Consumer extension          | The framework is a normal dependency. Pi packages imported by the consumer remain that consumer's host peers.                                                                               |
| Provider extension          | The framework and runtime-specific backend clients are normal dependencies. Pi packages imported by the provider remain host peers.                                                         |
| Provider contract-test user | Vitest is a development dependency. The framework declares it as an optional peer for `/testing`. Production exports do not import it.                                                      |

The framework is not a required peer of provider or consumer packages. Its
normal dependency can be installed independently with each extension. Runtime
sharing uses the discovery protocol and must work across separate SDK module
copies; package-manager deduplication is not part of the contract. Do not bundle
backend-specific clients into the framework to support external providers.

The release manifest follows Pi's guidance for host peer ranges, with `"*"` for
host-provided Pi packages. The supported/tested Pi baseline remains explicit in
documentation and CI; a permissive peer range does not establish compatibility.
The current private scaffold pins its development and peer entries to Pi 1.5.0.
Vitest's optional peer range must match the versions covered by contract tests.

Publish JavaScript and declarations for importable subpaths. Include the broker
and adapter JavaScript in the tarball. Pi supplies its own runtime packages;
declare them as peers, keep development versions pinned for tests and never
bundle them. Consumer/provider packages declare the SDK dependency explicitly.
Installing the SDK dependency does not register Pi tools or commands. It is
sufficient for the consumer to use `/api`: the SDK can initialise the shared
service without a separate framework installation or a Pi settings entry.

A project that installs the framework as an npm dependency can opt into tool
routing with `.pi/extensions/byos-tools.ts`:

```typescript
export { default } from 'pi-bring-your-own-sandbox/pi-tools';
```

This requires normal Node resolution from that project. For Pi-managed packages
with separate dependency roots, provide the equivalent explicit extension-file
loading instructions. Do not assume that a project extension can import an SDK
from Pi's private package installation directory.

## Provider contract

The SDK defines explicit types for the following contracts. They are framework
types, not existing Pi APIs.

| Type                      | Required contents and semantics                                                                                                                                                                                                            |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `SandboxProvider`         | Stable provider ID, display label, protocol version, supported capabilities/policy values, configuration validator and `open(request, context)`.                                                                                           |
| `SandboxOpenRequest`      | Runtime generation ID, Pi session ID, host workspace directory, validated provider configuration and required policy. Host paths here are provisioning metadata.                                                                           |
| `SandboxBackend`          | Backend ID, target workspace descriptor, actual capabilities, effective policy, non-secret recovery descriptor, foreground `exec()` and idempotent async `dispose()`. Optional filesystem/search operation groups must match capabilities. |
| `SandboxWorkspace`        | Target root, target platform/path flavour, optional target home/default shell, and a description of how workspace changes affect the host: shared, copied or remote.                                                                       |
| `SandboxOperationContext` | An `AbortSignal`, output callback where applicable and an operation ID. Opening also receives a recovery-report callback. Providers must honour cancellation and close pending transport work.                                             |
| `SandboxCapabilities`     | `exec` plus supported shell dialects and optional `files.read`, `files.write`, `files.list`, `search.grep` and `search.find`. Filesystem/search operations have separately specified contracts.                                            |

`open()` creates or attaches to a provider-owned workspace for this generation.
The provider decides how provisioning uses the host workspace. The broker does
not upload files or infer mount mappings. An attached resource must be owned or
leased explicitly so `dispose()` releases this session's allocation without
deleting a resource owned by another session.

`open()` must release partially created resources before rejecting. If release
cannot be confirmed, the provider returns a typed allocation error with a
non-secret recovery identifier and its lease/expiry mechanism. A failure after
container creation but before returning a backend is the provider's cleanup
responsibility. After releasing all reported allocations, the provider calls
`SandboxOpenContext.confirmCleanup()` immediately before rejecting. This
acknowledges allocation cleanup independently of operation cancellation. It
forbids later allocation or a successful backend return. The callbacks expire
when opening completes. Aborting an HTTP request is not proof of released
allocation.

Before provisioning, report a non-secret recovery descriptor through the opening
context. It identifies the allocation operation or intended resource, describes
how to recover it and specifies its lease/expiry mechanism. Update the
descriptor when resource IDs become available, and include the final descriptor
unchanged on the returned backend. One descriptor covers every resource from
that opening. Each update replaces the previous snapshot and must still cover
all outstanding resources. `lease` describes cleanup; it is not an allocation
key. An allocation descriptor cannot be replaced with `none`. A failed opening
acknowledges cleanup through `confirmCleanup()`. The broker retains the latest
descriptor before cancellation or disposal starts. If a provider stops
responding, cleanup diagnostics use that retained metadata; they do not depend
on a timed-out operation returning recovery information. Providers without a
persistent allocation explicitly report that fact.

Provider configuration enters the validator as `unknown`. The broker accepts
only validated values. Neither the SDK nor a consumer imports a provider's
runtime-specific client types. Provider credentials come from provider-owned
configuration or credential lookup, not from status output or transcript data.

Provider instances belong to provider-factory state. Broker state and backend
resources belong to the live Pi runtime generation, including when the SDK
creates the service on demand. Immutable types and constants may be shared
across imports; mutable registries, active backends and startup promises may
not.

## Discovery and registration protocol

Use literal versioned discovery channels, initially
`pi-byos:discovery:v1:brokers` and `pi-byos:discovery:v1:providers`. Do not
depend on module identity, `instanceof`, a shared `Symbol`, or Pi internals.
Validate every event payload structurally.

`registerSandboxProvider(pi, provider)` synchronously installs a responder
during the provider factory. Broker service creation also installs its responder
synchronously. These responders answer collection requests through callbacks in
the payload. Replies must happen before the handler returns and must perform no
asynchronous work. The SDK collects all replies before deciding the outcome.
This synchronous reply rule is a protocol requirement, with a Pi integration
test for the event-bus behaviour.

`getSandbox(pi, ctx, options)` runs only from a live event, command or tool
context after extension loading. It first collects broker replies. If none
exist, the SDK synchronously creates and publishes a session-scoped broker
through the calling extension's Pi API, then acquires through that service.
Discovery and publication must complete without an intervening await, so two SDK
copies cannot each create a service before the other's registration becomes
visible. The service owns its generation state and lifecycle handlers; it is not
stored in a module singleton. Diagnostics use the same ensure-service operation
and reuse an existing compatible service.

Duplicate, malformed or incompatible broker replies are errors; they do not
trigger creation of a second service. Backend startup and errors travel through
the service's returned promise, not through the event bus. There is no polling
loop or factory-time wait for another extension to load. Configuration is read
and validated before selecting or opening any backend, including `passthrough`.

On initialisation, the broker includes all providers in the built-in registry
and collects the live provider declarations. IDs in that registry are reserved.
The registry selects `passthrough` as its initial default implementation. All
factories have completed by this point, regardless of lifecycle-handler order. A
declaration from a failed factory has no live responder because Pi removes that
factory's subscriptions. This avoids retaining a registration that the provider
factory emitted before failing.

The provider set is fixed for the generation after collection. A new provider,
configuration change or provider replacement requires `/reload`. Collect and
validate duplicate provider IDs before selection, including IDs that are not
selected. Duplicate brokers, incompatible protocol versions and malformed
declarations produce explicit errors; the first reply does not silently win.

Service protocol version `1` is independent of npm package versions and the
discovery-envelope version. A future service version must still answer the
stable discovery-v1 channel with its supported service versions, so the SDK can
distinguish an incompatible service from a missing broker. Optional metadata
fields can be added within service version 1 when they preserve existing
semantics. New capability literals or changes to an existing operation's meaning
require a service protocol version change. Late or repeated discovery callbacks
cannot modify a closed collection.

## Selection and configuration

A provider extension calls `registerSandboxProvider(pi, provider, options)`
during its factory. Registration activates the provider without resolving
settings or allocating resources. The optional `configure` callback returns
`configuration`, a complete base `policy`, optional `userShell` and cleanup
overrides. The policy may be omitted when the provider declares `defaultPolicy`.
Without a callback, provider input defaults to an empty object.

The SDK does not read files or select providers from project settings. A
provider extension chooses its configuration source and validates provider input
through `validateConfig`. The callback receives the live Pi context, a shared
abort signal and the configuration deadline. Resolution runs once after
extension loading and is shared across callers. Cancelling an acquisition does
not cancel shared resolution. Shutdown cancels resolution, and failures remain
errors for that runtime generation.

Configuration resolvers can call `reportDiagnostic` with a user-facing warning,
including the configuration path and invalid field. Configuration and ordinary
backend diagnostics share the runtime's bounded store. Status includes these
warnings even when configuration fails. Raw exception causes remain private;
reports after the resolver finishes are ignored.

Provider authors must choose their configuration directory explicitly. Pi 1.5.0
extension contexts do not expose an agent directory passed through an embedding
host's `agentDir` option. `getAgentDir()` uses the process-wide
`PI_CODING_AGENT_DIR` setting or Pi's default directory, so that helper may
select a different directory from the embedded runtime. A provider extension can
accept a directory from its embedding host through a factory argument or
closure. BYOS does not infer that directory from the working directory or
session paths.

With no activation, the built-in passthrough implementation is selected. One
activation selects that provider for all consumers. Multiple activations, even
with different IDs, are errors before resolution or allocation. Duplicate IDs
and malformed declarations also fail. Loading order does not select a winner. A
provider failure never selects passthrough.

Approval and outside execution settings have separate callbacks:
`configureExecutionApproval` and `configureOutsideExecution`. Each permits one
binding per runtime generation. Conflicting bindings fail. The default approval
policy is `user`, and the default outside destination is `normal`. An extension
can supply either callback independently of the sandbox provider. Register all
bindings before first use; reload to change them.

[Approval and outside execution][approval-execution] specifies these services.

[approval-execution]: approval-execution.md

### Optional guard

`registerSandboxRequirement(pi, requirements = {})` requires explicit provider
activation for this runtime. Optional `providerId`, capability, process-kind,
shell, exit-status, termination-scope and policy requirements apply to every
ordinary acquisition. Multiple registrations apply together. Policy requirements
tighten the base policy before consumer negotiation; consumers cannot loosen
them.

The separate `pi-bring-your-own-sandbox-guard` package supplies a default Pi
extension and `createSandboxGuard(requirements = {})`. The default accepts any
activated provider. The guard has no SDK configuration file or flags and does
not replace Pi tools or register tool-call interception hooks.

Missing activation, a mismatched ID or unsupported declared guarantees blocks
ordinary and outside acquisition before allocation or approval. The ordinary
backend must also satisfy all guard requirements after opening. Approved outside
execution retains its independently configured destination and policy. Checking
the ordinary provider declaration does not open the ordinary backend.

Register requirements before configuration starts. Registration snapshots
inputs; late registration fails. Reload creates a fresh runtime. Guard-free
consumers retain default host execution. An explicitly activated host
implementation uses the same requirements as other providers.

IDs and capabilities are unauthenticated declarations on Pi's event bus. The
framework cannot verify which installed extension registered an ID or prove that
a provider enforces its policy. The guard prevents missing or conflicting
configuration within the cooperative threat model.

The shared policy vocabulary is deliberately small:

- `workspaceAccess`: `read-only` or `read-write` for the project workspace.
- `filesystemScope`: `workspace-only`, `system-read-only` or `provider-default`.
  Workspace-only forbids access to host files outside exposed workspace mounts.
  A provider may expose its isolated runtime image, home and scratch
  directories; it must describe these separately. System-read-only additionally
  permits read-only host operating-system files and installed runtime
  dependencies. It excludes other host user data outside the workspace.
  Providers must describe the exposed system/runtime roots in
  `policyDescription`, canonicalise their paths and reject grants that expose
  unrelated host files. Read-only does not make credentials safe to expose. A
  workspace inside a home directory remains accessible under workspace policy;
  selecting the home directory as the workspace exposes that directory.
  Arbitrary additional data grants require a different provider policy.
- `workspaceProtection`: optional immutable resource requirements. Provider and
  consumer sets are combined. See [protected resources][workspace-protection].
- `networkAccess`: `denied` or `provider-default`. Denied blocks outbound
  network access from sandboxed operations, including access through host
  services.

[workspace-protection]: workspace-protection.md

Filesystem scope requirements have this ordering, from weakest to strongest:
`provider-default`, `system-read-only`, `workspace-only`. Negotiation chooses
the least restrictive supported value that satisfies both base and consumer
requirements. A backend must satisfy the same ordering after opening. A provider
cannot advertise a restrictive value until independent probes verify normal
access, denied host-home files, runtime symlink targets and conflicting grants.
The provider test kit requires `verifyPolicy` for either restrictive value.

A provider may declare a complete `defaultPolicy`. Each value must be among its
supported policy values. When extension settings omit `policy`, use the selected
provider's declared default. If the provider declares no default, require a
complete base policy. An explicit policy replaces the complete default and must
still be supported; partial policies remain invalid. Provider registration
activates that provider; merely importing the SDK does not.

Passthrough declares `read-write`, `provider-default` filesystem scope and
`provider-default` network access through the same metadata as other providers.
It reports host permissions and no isolation. Its workspace root is `ctx.cwd`,
and it supports ordinary host execution and filesystem operations through the
same cancellation, result and mutation contracts. Search and shell dialect
capabilities reflect the available implementation on that host.

`passthrough` does not claim to enforce read-only access, workspace containment
or denied network access. Requests for those protections fail before execution.
Consumer authors ordinarily omit policy requirements so the SDK follows the
user's separate execution-environment choice. A consumer whose function requires
isolation may request it explicitly and explain that requirement.

Providers advertise supported values and must reject a policy that they cannot
enforce. Backend startup reports the effective policy, which must satisfy the
request before any consumer receives a handle. `provider-default` explicitly
delegates that policy dimension to the provider; status output must describe the
effective behaviour without claiming a common restriction. Host-side
control-plane traffic needed to operate a remote provider is separate from
sandbox egress.

Consumers can require capabilities and stricter common policy values when
acquiring a handle. The broker negotiates each request against the base policy
and the selected provider's declaration. Omitted fields, and fields that request
`provider-default`, keep the base value. A request can tighten a field
(`read-only` instead of `read-write`, `workspace-only` or `denied` instead of
`provider-default`) but cannot loosen one, so the base policy is both the
default and the limit. The broker opens one backend from the selected provider
for each distinct negotiated policy, and consumers that negotiate the same
policy share it. A request that the declaration cannot satisfy fails before any
backend is opened. A consumer must not change policy through a command argument
or request a different provider.

Every backend of a generation is opened for the same host workspace. A provider
that copies the workspace gives each backend its own copy, so changes made
through one backend are not visible through another. Consumers that need to see
another consumer's changes can check the `workspace` relationship.

## Consumer API

`getSandbox(pi, ctx, options?)` returns a facade for the selected sandbox. The
ordinary consumer call is `getSandbox(pi, ctx, { signal })`; it works with
default host execution or the user's configured provider. No provider-specific
branch or separate opt-in to the framework is required in the consumer.
`SandboxAcquireOptions` contains optional `capabilities`, `processKinds`,
`shells`, `exitStatus`, `terminationScope` and `policy` requirements, plus an
explicit caller `signal` and waiting `timeoutMs`. The waiting deadline defaults
to 60 seconds. It limits this acquisition only; the broker independently owns
the shared provisioning deadline. A cancelled waiter rejects immediately without
cancelling provisioning for other consumers. If all waiters cancel, provisioning
continues under the broker's deadline and the resulting backend remains
available for this generation. Shutdown still cancels provisioning. Check abort
again before returning a facade.

`negotiateSandbox(pi, ctx, options?)` applies the same negotiation without
opening a backend. It returns either the policy that acquisition would open or
the typed error that it would throw.

The facade exposes immutable identity, workspace, effective policy and
capabilities, plus methods for supported operations. It does not expose the
backend object, raw transport client or a consumer-callable backend disposer.
Every invocation checks runtime validity and requirements.

Ordinary consumer code uses the same API in either environment:

```typescript
const sandbox = await getSandbox(pi, ctx, { signal });

const result = await sandbox.exec(
  { kind: 'argv', executable: 'git', args: ['status', '--short'] },
  { signal, timeoutMs: 10_000 }
);
```

An operation that specifically requires denied network access can request it.
This call fails if the selected provider, including default `passthrough`,
cannot enforce the requirement:

```typescript
const sandbox = await getSandbox(pi, ctx, {
  capabilities: ['exec'],
  policy: { networkAccess: 'denied' },
  signal,
  timeoutMs: 15_000
});

const result = await sandbox.exec(
  { kind: 'argv', executable: 'git', args: ['status', '--short'] },
  { signal, timeoutMs: 10_000 }
);
```

The SDK is usable from tools, commands and lifecycle handlers. In a tool, the
consumer passes its execution signal to acquisition and execution. Pi's
`ctx.signal` is an agent-turn signal and does not necessarily identify that tool
call. Outside a turn, the broker still supplies its own session-lifetime signal
and deadline. Acquiring a sandbox is async; provider registration is synchronous
and does not acquire one.

If a consumer needs Pi validation, tool hooks, renderable output and nested-call
accounting, it should call a routed tool through `ctx.executeTool()`. Direct SDK
operations do not pass through Pi's `tool_call` permission hooks. Providers
enforce sandbox policy on both paths. Consumer authors must choose and document
the appropriate path, and must not assume that an SDK call inherits Pi tool
permission decisions.

## Process execution

Provider contexts include a synchronous `reportDiagnostic` callback for
structured warnings. Warnings are independent of workload output and retain
broker-supplied operation and resource identities. Each generation retains at
most 64 warnings of at most 2,048 UTF-16 code units each. Invalid, empty,
oversized and excess diagnostics increment `diagnosticsDropped`; reports after
completion are ignored. Status snapshots and `/byos status` expose retained
ordinary and outside-execution warnings without allocating a backend. A warning
never weakens capability, policy or confirmed-termination requirements.

Providers declare supported `processKinds`: `argv`, `shell`, or both. At least
one form is required. Shell-only providers need not implement argv. Shell
dialects must be non-empty exactly when shell requests are supported. The broker
rejects unsupported forms or dialects before provider invocation.

Providers also declare `exitStatus: "guaranteed" | "optional"`. Guaranteed
status promises an exit code or signal for every completed invocation. Optional
status permits `{ kind: "unavailable" }` after the supported foreground work has
stopped. This result does not establish command success and does not make the
backend unhealthy. Unknown termination retains its existing quarantine
behaviour. Consumers can require guaranteed status during acquisition. A backend
may strengthen an optional provider's guarantee but cannot weaken a guaranteed
declaration.

`ProcessRequest` is a discriminated union:

- `argv`: executable and argument array, with no shell interpolation.
- `shell`: command string and explicit dialect, initially `bash`, `sh` or
  `powershell`. The provider must advertise that dialect.

Both variants accept a target working directory and explicit environment
overrides. The default directory is the target workspace root. Relative paths
resolve in the target environment. Executable lookup uses the target's `PATH`.
The broker never joins an argument array into a shell command. A provider may
use a fixed, trusted internal transport shell with a validated, lossless
encoding. The target must receive the requested executable and argument values
with their original boundaries, including empty arguments, quotes, whitespace,
newlines, Unicode and shell metacharacters. Transport encoding must not perform
variable expansion, command substitution, globbing or interpretation of caller
data as shell syntax. Executable lookup must use the target environment and
working directory; the transport must not substitute a shell builtin, function
or assignment for the requested executable. Concatenating unencoded caller
values into shell text is invalid.

Using a transport shell does not advertise that dialect for `shell` requests.

Bootstrap execution uses provider-controlled executables and environment. Caller
environment overrides apply to the target program, including `PATH` changes and
variable deletion. They must not select or configure the transport shell,
trigger bootstrap startup hooks or affect other bootstrap programs. A fixed
shell path alone does not protect against startup hooks or loader variables.
Providers must separate bootstrap execution from application of target
overrides.

Internal transport must preserve the distinction between failure to start and
the target's exit status. A missing executable produces
`SandboxPathNotFoundError`; a target that starts and exits with code 127 returns
that exit result. Transport diagnostics must not enter target stdout or stderr.
These requirements do not change foreground completion or cancellation
guarantees.

The environment contains provider-owned runtime defaults and explicit caller
overrides. `passthrough` uses the normal host environment, including inherited
variables, as ordinary unsandboxed commands do. External providers do not
implicitly copy the host's `process.env` or Pi credentials. Provider policy may
reject an override. Shell adapters must filter any host environment that Pi
passes to an external backend's `BashOperations`; Pi session metadata is opt-in
and must not include credentials.

Provider execution streams ordered
`{ stream: "stdout" | "stderr", data: Uint8Array }` chunks and returns an exit
result. The broker captures bounded stdout and stderr for the facade result: 1
MiB combined by default, adjustable downward per call. Continue draining after
the capture limit and report omitted byte counts. Output callbacks are
synchronous and must not retain unbounded buffers; they are not a backpressure
API. A throwing callback cancels the operation and produces a typed error. No
chunks may arrive after completion.

Use streaming UTF-8 decoding at text-adapter boundaries. The provider API keeps
bytes so split code points and binary output are not corrupted. The facade's
exit result distinguishes an exit code from signal termination. A signal result
includes its target OS number so adapters can derive a shell status without
using the host signal table. The process result includes duration and truncation
metadata. A non-zero exit is a command result. Failure to start, transport
failure, cancellation and timeout are typed operation errors.

Public deadlines use milliseconds and finite positive values. Defaults are 60
seconds for opening, 120 seconds for foreground execution and 30 seconds for
filesystem/search operations; callers can supply another finite deadline.
Compose the caller signal, deadline and broker lifetime signal. Provider opening
uses only the broker's provisioning deadline and lifetime signal. Each waiting
acquisition has its independent cancellation signal and deadline.

Provider contexts expose `remainingMs()`, which calculates the remaining
allowance from monotonic time and returns zero after expiry. Nested operations,
queued prompts and sequential management commands must consume this same
allowance. `deadline` is a Unix-epoch timestamp for diagnostics; wall-clock
changes must not affect enforcement. Providers must observe both the allowance
and the cancellation signal. Remote transports must subtract elapsed queue and
transit time and must not assume that two processes share a monotonic origin.

Every provider and backend declares `terminationScope`, independently of access
restrictions and exit-status availability:

- `none` waits for a normal command result but makes no termination guarantee.
  Cancellation returns without waiting for a termination acknowledgement and
  reports completion `not-guaranteed`. The backend remains usable.
- `process-group` confirms that the direct process and its supervised POSIX
  process group have stopped. Descendants that change group or session may
  continue running and modifying permitted files, even when their parent waited
  for them.
- `workload` confirms that all processes in the invocation's execution boundary
  have stopped, including descendants that change group or session.

Acquisition can require a minimum `terminationScope`. The ordering is `none`,
`process-group`, then `workload`. An opened backend may strengthen its
provider's scope but cannot weaken it. Omitting a requirement accepts any
declared scope. The broker never changes providers to satisfy a consumer
requirement. Passthrough implements `process-group`; the container example
implements `workload`. Both use the same validation and execution contracts as
extensions.

For backend process execution, specify an explicit `BackendProcessOutcome`:

- `exited` includes the command's exit details, which may be unavailable for
  optional-status backends, and confirms termination within any promised scope.
- `cancelled` reports `confirmed` or `unconfirmed` for a promised scope, or
  `not-guaranteed` for scope `none`. Submitting a signal or aborting a transport
  request does not confirm termination.

Caller abort, deadline and broker shutdown request cancellation. Providers with
a promised termination scope have a configurable grace period for confirmation,
defaulting to five seconds. Late acknowledgements, unconfirmed termination and
unexpected failures make the backend unhealthy. Confirmed cancellation produces
the original cancellation or deadline error with completion `confirmed`.

For scope `none`, cancellation produces that error with completion
`not-guaranteed` as soon as the broker processes cancellation. The broker
observes late provider results without forwarding output or changing backend
health. This declared lack of a termination guarantee is distinct from an
unknown outcome when a provider fails to fulfil its promise. Normal results and
provider errors before cancellation still require valid protocol values.

Pi's native outside-shell operations provide no BYOS termination acknowledgement
and use scope `none`. SDK outside execution uses the selected backend's declared
scope. Status distinguishes the native Pi route from the SDK backend. The
framework delegates native shell execution to Pi.

Generation disposal remains independently bounded and must release the
provider's allocations. A confirmed close report does not promise termination
outside the advertised scope. Detached submission, PTYs and interactive stdin
remain outside this execution API.

For file mutations, a provider's cancellation error must state whether
completion is confirmed. Confirmed means that the operation can no longer change
data; unknown completion makes the backend unhealthy before releasing queued
work. Do not accept an immediate local abort rejection as proof that a remote
write stopped. Opening has the same bounded cancellation grace and
partial-allocation cleanup obligation. Backend disposal has a configurable
deadline, defaulting to ten seconds. Cleanup that cannot finish reports recovery
metadata and relies on the provider's lease or expiry; the broker never reports
successful cleanup from timeout alone.

Provider configuration callbacks can specify cleanup budgets:

```typescript
configure: () => ({
  configuration: {},
  cleanup: { cancellationGraceMs: 8000, disposalTimeoutMs: 15000 }
});
```

Each value is an integer from 1 to 300,000 milliseconds. Embedding hosts can
provide defaults through `initialiseSandboxHost`'s `cleanup` option. Provider
values override host defaults. The effective budgets are copied and frozen for
the generation and exposed as `sandbox.cleanupBudgets`. Outside execution uses
the same configuration. Consumers cannot extend a generation's cleanup budgets
through per-call execution options.

Providers receive a stable `context.cleanup` object. Its `remainingMs()` and
`deadline` are undefined during execution. Cancellation publishes the monotonic
cleanup allowance and diagnostic Unix-epoch timestamp before abort listeners
run. Disposal receives both values immediately. Providers can retain this object
across an await; spreading the operation context also preserves it. The
execution deadline remains separate. Repeated cancellation or settlement does
not extend the cleanup deadline. The broker enforces elapsed time with a
monotonic clock. Synchronous FFI still requires a worker or process if the
adapter must keep Pi responsive.

## Files, search and paths

Optional operation groups use target paths and typed byte/stat/search results:

- Read: `readFile`, read-access check and `stat`.
- Write: `writeFile`, write-access check and recursive `mkdir`.
- List: `listDirectory`, plus `stat` for entry types.
- Search: `find` with a glob/root/limit, and `grep` with pattern, literal/regex
  mode, glob, case handling, context and limit. Return structured results with
  explicit truncation metadata. Providers document regex, glob and ignore rules.

`files.writeFile` accepts an optional `createParents` flag, which defaults to
false. With that flag, target parent creation and the complete write use one
mutation queue entry and deadline. A later queued transformation observes the
completed write. Providers still implement separate `mkdir` and `writeFile`
methods.

The facade additionally exposes `files.updateText(path, transform, options)`
when both read and write are supported. The broker runs access/read/transform/
write as one entry in the same mutation queue as `writeFile` and `mkdir`.
`transform` is a synchronous function from the current text to replacement text;
it cannot perform asynchronous I/O or reacquire the mutation queue. Return the
original and replacement text to the caller. A thrown transform does not write.
Consumers use this operation for read-modify-write transactions. Providers still
implement only the lower-level filesystem methods.

Each method accepts cancellation and a deadline. The broker checks capabilities
before calling the backend and never fills an absent method with host Node I/O.
Permission denial, missing path and transport failure are distinct errors.
Symlink resolution and access enforcement happen inside the backend boundary;
lexical prefix checks alone are insufficient.

Search capabilities describe available operations, without a Pi-compatibility
profile. Providers document regex dialects, glob matching, ignore behaviour and
result selection. Returned paths are target-relative and matches include typed
line/context data. Result order is provider-defined. The broker validates paths,
limits, duplicate identities and context bounds; it does not format Pi output.
`truncated` reports an omitted result, including when a provider scans beyond
its returned limit to determine that fact.

The built-in host backend uses installed fd and ripgrep. Its results use UTF-8
path ordering before limits, with numeric line ordering for grep. Find excludes
`.git` and `node_modules`. These are host-provider behaviours, not requirements
for every sandbox provider or changes to Pi's built-in search tools.

The byte-returning file API buffers a complete file. The API does not promise
bounded memory for arbitrary file reads. Process-output capture has a separate
bound; Pi's model-output truncation does not limit file-read memory.

The public SDK uses target-native paths. It does not expand host `~`,
reinterpret host absolute paths or apply host filesystem existence checks. An
explicit path flavour controls lexical validation of workspace metadata and
search/list results. File contents and writes occur in the target workspace;
remote/copied workspaces are not automatically synced.

Pi integration translates paths only at a public backend-operation boundary.
Target path conversion must not reproduce Pi's leading `@`, Unicode-space, image
detection or other input-handling algorithms. If Pi resolves or probes host
paths before invoking custom operations, that path needs an upstream hook. A
path with incomplete routing is reported as unsupported by the integration.

## Lifecycle and concurrency

The broker uses explicit states: initialising, idle, opening, ready, failed,
closing and closed. Each backend has its own opening, ready or failed state and
opening promise, and the broker creates at most one backend for each negotiated
policy in a generation. The generation's reported state follows the backend for
the base policy. Both `session_start` and acquisition can initialise session
metadata, so a consumer's earlier start handler cannot deadlock while waiting
for the broker's later start handler.

Opening is lazy by default. Diagnostics can validate selection and capabilities
without allocating a VM or container. Concurrent consumers that negotiate the
same policy share the successful backend. A failed opening remains failed until
reload; arbitrary operations do not trigger repeated provisioning attempts. A
failure affects only the backend for that policy.

One failed command does not invalidate the backend. A transport failure with
unknown operation outcome or an unconfirmed cancellation does. The broker never
replays mutations. Serialise SDK file mutations that share a sandbox, including
read-modify-write edits; do not serialise unrelated reads or foreground commands
merely because they use one backend. Commands can modify files outside this
mutation queue; the API does not promise transactional filesystem access.

When the broker observes `session_shutdown`, first mark the generation closing
and reject new work. This transition is the shutdown linearisation point. Pi
awaits handlers in extension order, so an earlier consumer shutdown handler can
still operate before the broker's handler runs. The framework cannot promise an
earlier global shutdown barrier through public Pi APIs. Embedding hosts that
need that barrier call `closeSandboxSession` before emitting shutdown.

Abort startup and active operations, await them within bounded cleanup, dispose
the backend once, revoke facades and remove generation-owned listeners. Keep the
service's discovery responder and lifecycle handlers until Pi invalidates the
runtime. A closed generation remains discoverable so acquisition cannot create a
replacement broker during shutdown. If startup completes after shutdown began,
dispose the resulting backend immediately. Do not publish that backend. Cleanup
must be idempotent across overlapping close paths and must report failures
without deleting unrelated provider resources.

Reload, new session, resume and fork create fresh broker state and a fresh
backend lease. Resuming a transcript does not reconnect to an old backend by
default. Ordinary navigation within a session tree keeps the workspace; file
changes are not rolled back with conversation navigation. These rules must be
visible in provider documentation.

Check a live Pi context at each facade entry, as well as the generation state,
so raw Pi disposal also rejects cached handles. Bare `AgentSession` embedding
hosts must call the exported `closeSandboxSession(pi, ctx)` before
`session.dispose()`, or use `AgentSessionRuntime.dispose()`. Raw disposal and
process crashes cannot guarantee async backend cleanup. Remote providers need
leases, expiry or another provider-owned recovery mechanism.

Separate Pi sessions and child agents require separate resource loaders/event
buses and extension factories. No ambient sandbox inheritance is promised.
Cross-process children initialise their own service and use default host
execution unless their own configuration selects a provider. A future explicit
sharing protocol would need independent lifetime and policy rules. An SDK host
that deliberately shares an event bus across unrelated sessions is outside the
supported embedding configuration.

## Optional Pi integration

Integration is a separate opt-in extension entry. It supplies broker-backed
operations through Pi's public extension points. Registering diagnostics
preserves Pi's tools and active tool selection.

Pi owns argument preparation, edit matching, read ranges, image processing,
search execution orchestration, truncation, progress updates, output schemas,
rendering and transcript storage. The framework does not copy those algorithms
or replace entire tool executors when Pi omits an operation hook. Private Pi
imports and patched copies of Pi are not integration mechanisms for this
package.

For each integration path, record the public hook, the operations delegated to
the selected backend, and any access that Pi performs outside that hook. A path
is supported only when that boundary is sufficient. Missing hooks, host path
probes, edit previews outside the operation boundary and host-only full-output
references are upstream Pi issues. Record a minimal reproduction and required
extension point; do not compensate with a local executor or presentation layer.

For model shell tools, supply `BashOperations` to Pi's public definition
factories. Pi continues to construct tool results and publish updates. Translate
SDK cancellation/deadline failures only as required by the hook contract. Keep
sandbox process capture separate from Pi's display and transcript storage.

The public `user_bash` hook supplies operations for user shell commands. Return
operations immediately, then acquire inside `operations.exec()` with Pi's
per-command signal and deadline. Pi installs user-shell cancellation after the
handler returns. A cancelled cold-start waiter must never execute its command
when shared provisioning finishes. Resolve the configured `userShell` or the
backend's advertised default; reject a missing or unsupported dialect.

The `user_bash` bridge must return operations or throw. Returning `undefined` on
a broker failure would permit local execution. A selected provider failure never
switches to host execution. With no provider selected, supported hooks use the
same default `passthrough` service as SDK consumers.

Pi 1.5.0 returns a cancelled user-shell result when its abort signal is set,
even if custom operations report an unconfirmed stop. That result does not
confirm SDK termination. The broker quarantines the backend and diagnostics
report the unknown outcome. Pi exposes no public way to enumerate or reorder
competing `user_bash` handlers; document that an earlier handler can consume a
command before this bridge runs.

Direct SDK operations bypass Pi tool hooks. Model calls and nested
`ctx.executeTool()` calls retain Pi's validation, approval and result hooks when
Pi invokes the configured operations. Tests exercise those real dispatch paths
with a scripted model and fake approval decisions. Neither integration path
intercepts arbitrary extension code, MCP processes or embedding-host calls that
omit custom operations.

## Errors and diagnostics

Export concrete error classes with typed context, including
`ProviderNotFoundError`, `SandboxTimeoutError` and `SandboxTransportError`. Each
class determines its display message and stable literal `name`. `SandboxError`
is an abstract base; `SandboxErrorInfo` is the union of concrete errors.
Operation, provider/backend IDs and recovery metadata are direct properties.
Cancellation reasons and completion states use closed literal types.

Consumers use `isSandboxError(error, ErrorClass)` across separate SDK
installations. The guard checks the version marker, stable class identity and
context. `instanceof` only recognises the local SDK's constructor. Do not
include environment values, credentials, command contents or file contents in
routine diagnostics. Diagnostic causes must not be serialised or printed
automatically.

Initial classes cover service initialisation, duplicate brokers, incompatible
protocols, invalid declarations, configuration and requests, missing or
duplicate providers, unsupported capabilities or policies, startup failure,
stale handles, closing sessions, permission denial, missing paths, operation
failure, transport failure, cancellation, timeouts, output callback failure,
unconfirmed termination and cleanup failure.

Provide `/byos status` and `/byos providers`. Status reports provider,
generation, lifecycle state, target root, workspace relationship, effective
policy, capabilities and whether Pi tool routing was requested and verified. The
optional shell factory advertises its loaded state for diagnostics. Pi 1.5.0
cannot establish complete handler ownership through its public API, so routing
must remain unverified even when the factory is loaded. Status identifies
`passthrough` as host execution without isolation and states whether selection
came from the implicit default or explicit configuration. Commands work in TUI
and headless modes without requiring an interactive dialogue. A lightweight
status indicator may summarise ready/failed state in the TUI.

The framework does not write executable handles, credentials, raw provider
configuration or backend clients into Pi session entries. Diagnostic output must
describe the selected provider through its declaration label, and make
provider-default policy and incomplete cleanup visible. Failed-startup status
includes outstanding recovery instructions. Shutdown displays incomplete cleanup
before runtime invalidation. During an active turn, Pi defers custom messages,
so the broker also writes a non-secret `byos-cleanup` entry and sends a UI
warning.

## Verification requirements

Automated tests must verify:

1. Independently loaded provider and consumer extensions, with separate SDK
   module copies, exchange operations through one broker in every factory order.
   With only consumer extensions installed, the SDK initialises one shared
   service and supports host execution without configuration or prompts.
2. The same consumer works with two implementations of the provider contract
   without provider imports or conditionals. At least one example uses an actual
   isolated process backend.
3. An installed but unselected provider does not change default host execution.
   Missing explicitly selected providers, policy/capability mismatches, invalid
   configuration, duplicate IDs and backend failures produce typed errors with
   no switch from a selected sandbox to host execution.
4. Streaming, non-zero exit, cancellation, deadline, concurrent startup and
   shutdown-during-startup obey the specified semantics.
5. Reload, replacement, raw disposal and concurrent sessions reject stale work
   and release resources according to the documented host lifecycle.
6. Optional integration uses supported public operation hooks. Tests identify
   the covered execution paths, retain Pi approval/result hooks and verify
   selected-provider failures. Missing Pi extension points are documented as
   upstream blockers; the framework does not replace Pi tool algorithms.
7. The packed archive loads with Pi 1.5.0, importable SDK subpaths have usable
   declarations, and automated tests require no real model credentials.
