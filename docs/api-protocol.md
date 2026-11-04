# API and protocol appendix

This appendix is normative for service protocol version 1. The exported
[structural declarations][contracts] specify the exact fields and signatures;
the [protocol declarations][protocol] specify discovery and service objects. The
[specification][spec] specifies execution, policy and lifecycle behaviour. These
documents and declarations must change together.

[contracts]: ../src/contracts.ts
[protocol]: ../src/protocol.ts
[spec]: specification.md

The [development guide][validation] describes test commands and platform limits.
The [Pi integration guide][pi] specifies supported tool routing and upstream
extension-point gaps.

[validation]: validation.md
[pi]: pi-integration.md

## Public API

`/api` exports the consumer operations and provider registration specified by
`SandboxClient`, plus explicit host initialisation:

```typescript
initialiseSandboxHost(pi: SandboxHost, options: SandboxHostOptions): void;

getSandbox(pi: SandboxHost, context: SandboxContext,
  options?: SandboxAcquireOptions): Promise<Sandbox>;

registerSandboxProvider<Config>(pi: SandboxHost,
  provider: SandboxProvider<Config>): void;

closeSandboxSession(pi: SandboxHost,
  context: SandboxContext): Promise<SandboxCloseReport>;
```

`SandboxHost` uses Pi's public event bus, lifecycle registration, custom message
and custom entry writers. `SandboxContext` uses its live workspace, decision and
session manager. Callers pass a real live Pi context. Structural compatibility
does not authorise constructing a context that bypasses Pi's lifecycle checks.

An embedding host that supplies Pi's `agentDir` calls
`initialiseSandboxHost(pi, { agentDirectory })` once from its first extension
factory, before any broker or consumer factory runs. Use the same absolute
directory as Pi. This creates the shared service synchronously without reading
configuration or opening a backend. Late or repeated initialisation fails with
`SandboxInitialisationError`. Without explicit initialisation, the ordinary CLI
uses `getAgentDir()`. Each runtime requires a separate event bus.

Registration is synchronous, validates the declaration and installs a discovery
responder. It does not validate configuration, create a backend or allocate an
external resource. The built-in registry supplies its default provider and
reserves the IDs of its registered implementations. External IDs are non-empty
strings; duplicate IDs are errors even when unselected. The initial registry
uses passthrough as its default implementation.

Provider metadata may include a complete `defaultPolicy`. Its values must appear
in the provider's supported policies. Personal settings may omit `policy` when
the selected provider declares a default. An explicit complete personal policy
replaces that default; partial policies remain invalid. The broker snapshots and
freezes defaults during registration, discovery and enumeration. Status retains
the selected declaration's `providerLabel`, including after closure. Formatting
that label uses the captured metadata without additional discovery or
configuration.

Acquisition negotiates a complete policy from the request and the personal
policy, then uses the generation's backend for that policy, opening it if
necessary. Omitted fields and `provider-default` requests keep the personal
value. `read-only` tightens `read-write`; filesystem scopes progress from
`provider-default` through `system-read-only` to `workspace-only`.
`networkAccess: 'denied'` tightens network delegation. Requesting `read-write`
when the personal policy is `read-only` loosens it and fails with
`UnsupportedSandboxPolicyError`. A negotiated value that the provider does not
declare fails the same way, and a requested operation, process kind or shell
that the declaration lacks fails with `UnsupportedSandboxCapabilityError`; both
happen before any backend is opened. Exit status and termination scope are
checked after opening, because a backend may strengthen its declaration. Every
requested capability must then be present in the opened backend. Negotiation
never selects another provider.

`negotiate(context, options)` on the broker, exposed as `negotiateSandbox`,
performs the same checks without opening a backend. It resolves to
`{ ok: true, policy }` or `{ ok: false, error }`, where `error` is the typed
error that acquisition would throw. Status lists every started backend under
`backends`, with its negotiated policy, state and backend ID; the top-level
backend fields describe the backend for the personal policy.

`WorkspaceProtection` is either `{ kind: 'git-metadata' }` or
`{ kind: 'path', path: string }`. `SandboxPolicy.workspaceProtection` is an
optional readonly resource array. Any nonempty requirement needs the
`workspace.protection` operation capability. Effective resources must cover
every requested resource, including personal requirements. A protected parent
covers a child; Git metadata protection includes external repository
administration data. Registration rejects protected defaults without the
capability. See [protected workspace resources][workspace-protection] for path
syntax, preset expansion, immutability and independent enforcement requirements.

[workspace-protection]: workspace-protection.md

Facade methods always exist, including `files` and `search`. Unsupported methods
reject with `UnsupportedSandboxCapabilityError` before provider invocation. This
keeps consumer code independent of optional backend method groups. A facade has
no disposer, provider configuration or raw backend client.

## Values, ownership and validation

All metadata is a readonly snapshot. The broker copies and freezes metadata
before publishing a facade or status. Providers must not mutate declarations
after registration. Arrays contain unique supported literals; capabilities
always include `exec`. Shell dialects require execution support.

Execution metadata also requires non-empty `processKinds` (`argv`, `shell`, or
both), `exitStatus` (`guaranteed` or `optional`) and `terminationScope` (`none`,
`process-group` or `workload`). Shell dialects are non-empty exactly when
`processKinds` includes `shell`. Acquisition can require `processKinds`,
`shells`, `exitStatus: "guaranteed"` and a minimum `terminationScope`.
Termination scopes increase from `none` through `process-group` to `workload`;
an opened backend cannot weaken its declaration. Unsupported requests fail
before provider invocation. An optional-status provider may open a backend with
guaranteed status; a guaranteed provider cannot weaken that guarantee.

An opened backend may advertise fewer capabilities than its provider. It must
not advertise an undeclared capability, dialect or policy value. Its effective
policy must satisfy the opening request. The broker validates the backend before
publishing any consumer handle. Invalid backends are disposed and fail startup.

Backend method groups and capabilities must agree in both directions:

| Capability    | Required backend operations                |
| ------------- | ------------------------------------------ |
| `exec`        | `exec`                                     |
| `files.read`  | `files.read.readFile`, `access`, `stat`    |
| `files.write` | `files.write.writeFile`, `access`, `mkdir` |
| `files.list`  | `files.list.listDirectory`, `stat`         |
| `search.find` | `search.find`                              |
| `search.grep` | `search.grep`                              |

`files.stat` uses the read group when available, otherwise the list group.
`files.access` chooses the requested read or write group. `files.updateText`
requires both read and write capabilities. File sizes are non-negative safe
integers. Directory entries contain entry basenames and their kinds; they do not
contain host paths. `stat` follows the final symlink and reports the target
kind; a dangling link fails with `SandboxPathNotFoundError`. Directory-entry
kinds describe each entry without following its symlink. Access checks, reads
and writes resolve links inside the backend's policy boundary. The broker does
not authorise access based on the unresolved path.

Runtime validators reject missing fields, wrong primitive types, invalid
discriminants, non-callable methods and inconsistent declarations. Unknown
fields on protocol and metadata objects are ignored for forward compatibility.
Unknown framework configuration keys, operation keys and capability literals are
errors. Each provider defines validation of its own configuration keys. Explicit
`undefined` is treated as omission for optional fields. Required fields cannot
be `undefined` or `null`.

The configuration validator receives `unknown` and returns the provider's own
`Config` type. Its `open` receives that same type. The event-bus provider
service does not erase this relationship with a cast: `configure(input)`
validates and returns a closure whose `open` already includes the typed
configuration. Configuration validation must not allocate resources. Throwing a
validation error becomes `InvalidSandboxConfigError`; raw configuration is not
included in routine diagnostics.

Providers transfer each output chunk to the broker for the synchronous callback
only. The broker copies any bytes retained for capture and supplies a separate
copy to the consumer callback. Providers may reuse their original buffer after
the callback returns. The broker copies a write's input at facade entry so later
caller mutation cannot alter a queued write. Returned file and captured process
buffers belong to the consumer. Readonly properties do not make `Uint8Array`
elements immutable. At facade entry the broker also snapshots process arguments
and environment overrides, search inputs, and acquisition requirements before
awaiting any work. Caller mutation after invocation cannot change a pending
operation. Abort signals and synchronous callbacks retain their identity and are
not cloned.

## Provider diagnostics

Every provider operation context supplies synchronous `reportDiagnostic` for
`{ level: "warning", message: string }`. Warnings are separate from workload
stdout and stderr. The broker adds the operation ID, operation kind and known
provider/backend identities. Provider messages must be suitable for user display
and must not include credentials or raw configuration.

Each generation retains at most 64 warnings. Messages contain from 1 to 2,048
UTF-16 code units. Invalid, oversized and excess diagnostics are discarded and
increment a bounded counter. The status snapshot exposes immutable `diagnostics`
and `diagnosticsDropped` fields when populated. Reports after an operation
finishes are ignored. Diagnostics never satisfy missing capabilities, relax
requested policies or establish termination.

The optional diagnostic extension displays ordinary and outside-execution
warnings through `/byos status`. Status inspection does not allocate execution
resources. Providers do not need their own Pi notifications.

## Process, files and search

`ProcessRequest` discriminates `argv` and `shell`. Argv requires `executable`
and an argument array; shell requires `command` and `dialect`. Neither variant
accepts fields from the other. An empty executable is invalid. Empty arguments
and an empty shell command are valid. NUL bytes in executable, arguments,
command, paths or environment keys/values are invalid.

Argv execution preserves literal argument values and boundaries. Providers may
use a fixed, trusted transport shell with a validated, lossless encoding, as
specified in [Process execution][process-execution]. Caller data must not become
shell syntax. Executable lookup, target working directory and environment
semantics remain unchanged. Caller overrides must not affect bootstrap
execution, and transport diagnostics must not enter target stdout or stderr.
Failure to start remains a typed operation error, distinct from a target exit
status, including code 127.

`ProcessExit` also accepts `{ kind: "unavailable" }` for optional-status
backends. Completion follows the declared termination scope. Unavailable details
do not mean success or uncertain termination, and do not quarantine a healthy
backend. A guaranteed-status backend returning this variant violates its
declaration. Pi shell adapters convert this variant to `exitCode: null`, which
Pi reports as a failed command while preserving captured output.

[process-execution]: specification.md#process-execution

`env` replaces individual target environment entries. A string sets a value;
`null` removes the variable. An omitted key preserves the provider's runtime
default. Environment keys are non-empty and cannot contain `=`. External
providers never receive inherited host environment values implicitly.

`onOutput` is synchronous, ordered across the delivered stdout/stderr chunks and
receives bytes without text decoding. `maxCaptureBytes` is a non-negative safe
integer at most 1,048,576. The default is 1,048,576 across both streams in
delivery order. Zero disables capture while preserving streaming. Omitted byte
counts include every drained byte beyond the shared limit. `durationMs` is a
non-negative duration measured with a monotonic clock. Exit codes are integers;
signal exits use a non-empty target signal identifier.

Every provider operation receives a unique operation ID, a composed abort signal
and a live `remainingMs()` function based on monotonic time. The absolute
Unix-epoch `deadline` is diagnostic metadata. Public `timeoutMs` values are
finite and positive. Providers must respond to the signal as well as respect the
deadline. Public defaults and bounded termination grace periods are specified in
the process section of the specification.

The operation context includes a stable `cleanup` object. Its
`remainingMs(): number | undefined` reports the current monotonic cleanup
allowance. Cancellation publishes this allowance before abort listeners run;
disposal supplies it from the start. The separate `cleanup.deadline` is a
Unix-epoch timestamp for diagnostics. Retaining or spreading the context must
preserve the live budget function. Sequential cleanup commands consume the same
allowance. Remote transports must account for transit and queue time without
assuming a shared monotonic origin. Expiry does not establish termination;
providers must still acknowledge that work stopped.

`SandboxHostOptions.cleanup` and personal `byos.json`'s `cleanup` accept partial
`SandboxCleanupBudgets`. Personal values override host defaults. Both
`cancellationGraceMs` and `disposalTimeoutMs` accept integers from 1 to 300,000;
their defaults are 5,000 and 10,000. Facades and outside executors expose the
frozen effective `cleanupBudgets` for their generation.

Paths use the advertised target path flavour. Relative paths resolve from the
target root, including search roots and process working directories. The SDK
does not translate a host prefix or expand `~`; those are adapter operations.
`mkdir` creates missing parents. `writeFile` replaces the complete file and does
not create parents implicitly. `readFile` returns complete bytes. Text updates
decode strict UTF-8 and encode UTF-8 without changing line endings; an invalid
encoding fails before calling the transform or writing.

Find defaults to 1,000 paths; grep defaults to 100 matching lines. Supplied
limits are positive safe integers. Grep defaults are regex mode, case-sensitive,
zero context lines and no glob filter. Context is a non-negative safe integer.
Match line numbers are one-based. `before` and `after` contain adjacent lines
without newline terminators, nearest available context in file order. A matching
line produces one result even if the pattern matches several times. Paths are
relative to the search root, and `text` excludes its newline terminator.
`truncated` means at least one additional result was omitted. It is false when
the total exactly equals the limit. Providers document regex/glob syntax, ignore
behaviour and result selection. The framework does not require a Pi search
profile or impose a shared result order. Returned paths retain the target path
flavour. Duplicate paths or matching lines are invalid even when results use a
provider-specific order.

## Discovery envelopes and service identity

The SDK emits this object on either `pi-byos:discovery:v1:brokers` or
`pi-byos:discovery:v1:providers`:

```typescript
{
  kind: 'pi-byos.discover',
  discoveryVersion: 1,
  reply: (advertisement: unknown) => void
}
```

A responder synchronously calls `reply` exactly once with:

```typescript
{
  kind: 'pi-byos.broker' | 'pi-byos.provider',
  discoveryVersion: 1,
  serviceVersions: [1],
  id: 'non-empty service identity',
  service: brokerOrProviderService
}
```

The reply kind must match the channel. `serviceVersions` is a non-empty array of
unique positive safe integers. It advertises every compatible interface
implemented by this service object. Version 1 clients require `1` in that array.
The service's `id` must equal the envelope's `id`. A broker ID identifies the
shared service, not its changing runtime generation. A provider ID identifies
the registered provider and remains stable across its allocations. No ID depends
on object identity or module location.

The collector records replies without throwing inside `reply`. It closes the
collection as soon as synchronous `events.emit` returns, then validates every
recorded reply before choosing a result. This matters because Pi catches handler
exceptions. An async handler can reply only before its first await. Callbacks
after collection closes are ignored and cannot alter the outcome. Repeated
callbacks before closure count as separate replies. Repeated IDs, including
repeated replies with the same object, are duplicate-service errors.

Malformed replies fail with `InvalidSandboxDeclarationError`; valid discovery
envelopes whose service versions exclude `1` fail with
`IncompatibleSandboxProtocolError`. Duplicate IDs fail with
`DuplicateProviderError` on the provider channel. More than one broker reply
fails with `DuplicateBrokerError`, even when the broker IDs differ. Validation
does not silently discard an invalid reply because another reply is usable.

Provider discovery returns a `ProviderServiceV1`: immutable identity,
capabilities and supported policies, plus synchronous `configure`. The result
contains `open(request, context)` without a configuration field in the request.
Broker discovery returns `BrokerServiceV1`, with promise-returning `acquire`,
`close`, `status` and `providers` methods. These are direct in-process calls.
Functions, errors and abort signals are not serialised.

## Service bootstrap and lifecycle

No broker reply permits synchronous creation and publication of one service.
Discovery, creation, lifecycle registration and installation of its responder
must happen in one call stack before asynchronous configuration or provider
collection begins. Re-entrant discovery during incomplete publication must fail
with `SandboxInitialisationError`, not create a second service.

An invalid, incompatible or conflicting reply forbids new service creation. A
closed or stale service does not permit replacement within the same runtime. It
returns `StaleSandboxHandleError` or `SandboxSessionClosingError` as
appropriate. Session replacement and reload invalidate the old runtime and its
subscriptions. The replacement runtime uses a fresh event bus and creates a new
service on first use. The optional diagnostic extension uses this same bootstrap
operation.

Closing a generation retains the service's discovery responder and lifecycle
handlers until Pi invalidates that runtime. The responder advertises the closed
service so later calls cannot interpret shutdown as permission to recreate a
broker. Close removes only generation-owned operation listeners. A closed
service cannot initialise another generation; session replacement requires a
fresh runtime and event bus.

An opening recovery callback remains valid until `open` settles. It must be
called before allocation, may be updated synchronously or asynchronously during
opening, and must not be used afterwards. An opening reports one aggregate
recovery descriptor for all its resources. Each update replaces the previous
snapshot and must still cover all outstanding resources. The final backend must
include that descriptor unchanged. `lease` describes cleanup and is not an
allocation key. Replacing an allocation descriptor with `none` is rejected;
failed-open cleanup uses `confirmCleanup()`.

A close report is a snapshot of recovery information received before its
deadline. A provider that completes late still releases its allocation; a close
report cannot certify that cleanup in advance.

Before rejecting a failed opening, a provider calls
`SandboxOpenContext.confirmCleanup()` after releasing every reported allocation.
The acknowledgement excludes subsequent allocation and a successful backend
return. Recovery reporting and cleanup acknowledgement expire when opening
completes. Without acknowledgement, a rejected opening with reported allocations
retains manual recovery metadata. Cancellation completion alone does not
acknowledge allocation cleanup.

Status reports the generation state, effective selection and optional backend
metadata. Selection distinguishes implicit default and personal configuration.
The user-shell dialect is explicit when configured. Status never allocates a
backend. Provider enumeration validates configuration and declarations but does
not provision.

The optional diagnostic command queries loaded shell integration factories on
`pi-byos:diagnostics:v1:shell-integration`. It emits the same `pi-byos.discover`
request with `discoveryVersion: 1` and a synchronous reply callback. A loaded
factory replies with
`{ kind: 'pi-byos.shell-integration', discoveryVersion: 1 }`. Replies after
collection closes are ignored. No replies means not requested; unrecognised
replies make request status unavailable. This diagnostic query allocates no
backend and does not change broker or provider discovery. Routing remains
unverified because Pi does not expose competing user-shell handlers through its
public API.

Close is idempotent and returns the same completed report for its generation.
`confirmed` is true only when all generation-owned work and allocation cleanup
have been confirmed. Reports include non-secret recovery descriptors and typed
failures. Consumers cannot close a backend through a facade; an embedding host
uses the explicit session helper. Ordinary shutdown displays incomplete cleanup
and non-secret recovery instructions through Pi custom messages. If a turn is
active, Pi defers the message; the broker also writes the warning to a
`byos-cleanup` custom entry and sends a UI warning before runtime invalidation.
Status displays outstanding recovery from failed startup before explicit close.

## Structural errors and compatibility

The SDK exports a concrete class for each error, including
`ProviderNotFoundError`, `SandboxTimeoutError` and `SandboxTransportError`.
`SandboxError` is their abstract base. Each class accepts typed context and
optional `{ cause }`, then sets its stable literal `name` and display message.
Consumers do not supply message strings or free-form detail fields.

`SandboxErrorInfo` is the union of the concrete error types. Errors expose the
version marker `sandboxErrorVersion: 1`, `name`, `message`, `operation` and
optional provider/backend/recovery context directly. Configuration errors can
identify the personal source through `configurationSource`.

Use `isSandboxError(value)` to recognise supported structural errors, or
`isSandboxError(value, SandboxTimeoutError)` to narrow to a concrete type across
SDK copies. Each class supplies a static `errorName` with the same literal as
its instance `name`. The guard validates the version, identity and typed
context; it does not depend on constructor identity or parse display messages.
Causes are diagnostic values and must not be serialised or printed
automatically.

Cancellation errors include `reason: 'caller' | 'shutdown'` and completion.
Timeouts set reason `deadline`; output callback errors set reason `output`.
Transport errors and unconfirmed termination within a promised scope set
completion `unknown`, with an optional original cancellation reason.
`not-started` excludes provider invocation. For execution, `confirmed` excludes
later effects within the backend's declared termination scope. `process-group`
covers the direct process and its supervised POSIX group; `workload` also covers
descendants that change group or session. Those descendants may continue under
`process-group`, including when their parent waited for them.

Scope `none` makes no termination promise. Cancellation returns without waiting
for an acknowledgement and uses completion `not-guaranteed`, which is valid only
for execution and does not quarantine the backend. Late results are observed
without output delivery or health changes. A backend with a stronger scope must
not report `not-guaranteed`. Normal completion still waits for the command's
result. Unknown mutation or promised execution completion remains unhealthy.
Allocation disposal remains a separate obligation for every scope.

For example, a provider reports a known missing executable with
`new SandboxPathNotFoundError({ operation: 'exec', providerId }, { cause })`. A
consumer can recognise that error with
`isSandboxError(error, SandboxPathNotFoundError)` even when the provider and
consumer load separate SDK copies.

Adding optional metadata fields preserves version 1. New capability literals,
required fields, operation meanings or error variants require a new service
version. A future service version must still answer discovery-v1 with its
supported versions so version 1 clients can report incompatibility. The protocol
requires neither package deduplication nor a globally shared SDK constructor.

## Approval and outside execution services

The [approval guide][approval-guide] defines the exported contracts and
execution semantics. The framework package exports these APIs through `/api`;
policy extensions do not need to install or open a sandbox backend.

[approval-guide]: approval-execution.md

The independent service channels use discovery envelope version 1. Requests use
`{ kind: "pi-byos.discover", discoveryVersion: 1, reply }`. Replies use this
envelope:

```ts
{
  kind: "pi-byos.service",
  discoveryVersion: 1,
  serviceVersions: [1],
  id,
  service
}
```

Service IDs must match the advertisement. Replies must arrive synchronously;
late replies are ignored. Duplicate identities, malformed replies and
unsupported versions are errors. Callbacks, signals and service objects remain
in-process.

| Channel                                  | Service methods and metadata                                                 |
| ---------------------------------------- | ---------------------------------------------------------------------------- |
| `pi-byos:discovery:v1:approval-policies` | `id`, `label`, `configure(input)` returning a bound `decide` method.         |
| `pi-byos:discovery:v1:approvals`         | `id`, `request(context, request, options?)`, `policies()`, `close()`.        |
| `pi-byos:settings:v1`                    | `id`, `lifetime`, `close()`, `read()`, optional host-bound `normalExecutor`. |
| `pi-byos:discovery:v1:outside-execution` | `id`, `lifetime`, `acquire`, `track`, `assertLive`, `close`.                 |

The runtime settings and outside execution services are internal SDK protocols;
the public APIs acquire their shared instances. Settings are bound before use
and cached for the runtime. Closing a service preserves its closed tombstone.
The runtime settings lifetime also prevents creating new services after SDK
shutdown. Service construction publishes a bootstrap reservation before invoking
extension callbacks; re-entrant creation fails without allocating another
service. An approval service is independent of the ordinary sandbox broker and
its allocation state. SDK copies discover the same services through the live Pi
bus.

The provider-v1 service accepts optional `outsideSandbox` metadata with `label`,
`capabilities`, `policy` and `configure(input)`. That configure method returns
an allocation closure for the outside backend. Existing declarations without
this optional member retain their behaviour. The framework validates and
snapshots the optional metadata before use.
