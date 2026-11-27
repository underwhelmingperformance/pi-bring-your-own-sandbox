# API and protocol appendix

This appendix specifies protocol major 2 at feature level 0. The
[specification][spec] defines behaviour and identifies the consumers of the
contract. Runtime schemas define the types.

[spec]: specification.md

## Public entry points

| Entry point | Operations and types                                                                        |
| ----------- | ------------------------------------------------------------------------------------------- |
| `/consumer` | `createSandboxClient`, sandbox handles, requirements, error checks, review and escalation   |
| `/provider` | `registerSandboxProvider`, provider and backend contracts, errors and display helpers       |
| `/host`     | `initialiseSandboxHost`, `SandboxHostHandle`, host options and `registerSandboxDiagnostics` |
| `/pi-tools` | Pi shell integration factory and `registerShellOnlyTools`                                   |
| `/testing`  | `defineSandboxProviderTests` and `SandboxProviderTestFixture`                               |

The package prefix is `pi-bring-your-own-sandbox`. Wire schemas, channel
constants, broker objects and identity constructors are internal.

The [public API report][report] lists the exact exports and the declarations
that their signatures reference. Run `pnpm api:report` after an intended API
change.

[report]: ../api-report.txt

```typescript
createSandboxClient(pi: SandboxHost, extensionSource: string): SandboxClient;

interface SandboxClient {
  get(context: SandboxContext, options?: SandboxAcquireOptions): Promise<Sandbox>;
  negotiate(
    context: SandboxContext,
    options?: SandboxAcquireOptions
  ): Promise<SandboxNegotiation>;
  hasShellReviewRoute(): boolean;
  findShellReviewSource(
    context: SandboxContext,
    call: ReviewedToolCall
  ): ShellReviewLookup;
  recordEscalationDecision(
    context: SandboxContext,
    request: EscalationRequest,
    decision: EscalationDecision
  ): void;
}

registerSandboxProvider<Config, Input = Config>(
  pi: SandboxHost, extensionSource: string, provider: SandboxProvider<Config>,
  options?: NoInfer<SandboxProviderRegistration<Input>>
): void;
initialiseSandboxHost(
  pi: SandboxHost, extensionSource: string, options: SandboxHostOptions
): SandboxHostHandle;

interface SandboxHostHandle {
  readonly close: () => Promise<SandboxCloseReport>;
}
```

Create the client in the extension factory. Pass `import.meta.filename` for
`extensionSource`. The client uses that path for build election, errors and
ledger entries. Provider registration, the Pi tools and host initialisation
register their builds through their factory entry points.

`/host` is for embedding hosts. Call `initialiseSandboxHost` from an extension
factory. The returned handle is frozen. After startup, its `close()` method
shares Pi's session shutdown and returns the same cleanup report on every call.

`SandboxHostOptions` accepts `cleanup?: Partial<SandboxCleanupBudgets>` for
embedding defaults. The [provider's cleanup settings][provider-settings] take
precedence.

[provider-settings]: #provider-settings

## Requirements and profiles

<!-- `violations` is provisional in milestone 1. -->
<!--
Types `AccessProperty`, `Access`, `PathGrants`, `FileAccess` and `Profile`
are provisional.
-->
<!-- The policy field value types and `pathGrantKinds` are provisional. -->

```typescript
type AccessProperty =
  'network' | 'hostWorkspaceWrites' | 'hostUserData' | 'hostSystemFiles';

type Access = Readonly<
  Partial<Record<AccessProperty, 'needed' | 'prevented'>>
> & { readonly paths?: PathGrants };

interface PathGrants {
  readonly read?: readonly string[];
  readonly write?: readonly string[];
}

type Capability =
  | 'exec'
  | 'files.read'
  | 'files.write'
  | 'files.list'
  | 'search.find'
  | 'search.grep'
  | 'copy'
  | 'violations';
type ProcessKind = 'argv' | 'shell';
type ExitStatus = 'guaranteed' | 'optional';
type TerminationScope = 'none' | 'process-group' | 'workload';

interface SandboxRequirements {
  readonly access?: Access;
  readonly capabilities?: readonly Capability[];
  readonly processKinds?: readonly ProcessKind[];
  readonly shells?: readonly ShellDialect[];
  readonly exitStatus?: 'guaranteed';
  readonly terminationScope?: TerminationScope;
}

type FileAccess = 'denied' | 'read-only' | 'read-write';

interface SandboxPolicy {
  readonly hostWorkspaceWrites: boolean;
  readonly network: boolean;
  readonly hostUserData: FileAccess;
  readonly hostSystemFiles: FileAccess;
}

interface SandboxWorkspace {
  readonly root: string;
  readonly pathFlavor: 'posix' | 'win32';
  readonly relationship: 'shared' | 'copied';
  readonly home?: string;
  readonly hostUserDataRoot?: string;
}

interface Profile {
  readonly policy: SandboxPolicy;
  readonly capabilities: readonly Capability[];
  readonly processKinds: readonly ProcessKind[];
  readonly shells: readonly ShellDialect[];
  readonly exitStatus: ExitStatus;
  readonly terminationScope: TerminationScope;
  readonly pathGrantKinds?: readonly ('read' | 'write')[];
}

type SandboxNegotiation =
  | { readonly ok: true; readonly profile: Profile }
  | { readonly ok: false; readonly error: SandboxErrorInfo };
```

`SandboxAcquireOptions` extends `SandboxRequirements` with the optional
operation fields `signal` and `timeoutMs`. `ShellDialect` at level 0 is
`sh | bash | powershell`. The scope order is `none`, `process-group`,
`workload`. Profile lists contain unique entries. Capability, process-kind and
shell arrays contain unique literals. The `shells` array is non-empty exactly
when `processKinds` includes `shell`.

The selected profile requires `workspace.hostUserDataRoot` when `hostUserData`
is `read-only` or `read-write`. The root uses the target path flavour and must
be absolute. A profile with denied host user data omits the field. The broker
rejects an invalid descriptor with `InvalidSandboxDeclarationError` and
identifies `workspace.hostUserDataRoot` in `detail.field`. Docker omits this
field.

This table is the level 0 access mapping. The property and policy field use the
same identifier.

| Access property and policy field | Supported values, most to least restrictive | `prevented` | `needed`                       |
| -------------------------------- | ------------------------------------------- | ----------- | ------------------------------ |
| `network`                        | `false`, `true`                             | `false`     | `true`                         |
| `hostWorkspaceWrites`            | `false`, `true`                             | `false`     | `true` on a `shared` workspace |
| `hostUserData`                   | `denied`, `read-only`, `read-write`         | `denied`    | At least `read-only`           |
| `hostSystemFiles`                | `denied`, `read-only`, `read-write`         | `denied`    | At least `read-only`           |

For host user data outside the checkout, both readable values exclude the
[credential locations][credentials]. An escalation must specify a credential
path and receive approval for that call to grant access to the credential.
Directory grants keep the exclusions.

[credentials]: specification.md#credential-locations

The specification defines [profile ranking and path checks][access]. Through
`pathGrantKinds`, a profile can declare support for extra read and write paths
during escalation. An omitted or empty list provides no extra kinds.

[access]: specification.md#configuration-and-negotiation

Metadata returned to another caller is readonly and frozen. The runtime
validates shape and profile consistency. It snapshots input data before
asynchronous work. Abort signals and synchronous callbacks retain their
identity.

## Provider contract

```typescript
interface SandboxProvider<Config> {
  readonly id: string;
  readonly label: string;
  readonly profiles: {
    readonly open: readonly Profile[];
    readonly copy: readonly Profile[];
  };
  readonly validateConfig: (input: unknown) => Config;
  readonly open: (
    request: SandboxOpenRequest<Config>,
    context: SandboxOpenContext
  ) => Promise<SandboxBackend>;
  readonly copy?: (
    request: SandboxOpenRequest<Config> & {
      readonly source: SandboxCopySource;
    },
    context: SandboxOpenContext
  ) => Promise<SandboxBackend>;
}

interface SandboxOpenRequest<Config> {
  readonly generationId: string;
  readonly sessionId: string;
  readonly hostWorkspace: string;
  readonly configuration: Config;
  readonly profile: Profile;
  readonly paths?: PathGrants;
}

type SandboxCopySource =
  | { readonly kind: 'host' }
  | { readonly kind: 'backend'; readonly backend: SandboxBackend };

interface SandboxOpenContext extends SandboxOperationContext {
  readonly reportRecovery: (recovery: RecoveryDescriptor) => void;
  readonly confirmCleanup: () => void;
}

interface SandboxBackend {
  readonly id: string;
  readonly workspace: SandboxWorkspace;
  readonly profile: Profile;
  readonly policyDescription: string;
  readonly recovery: RecoveryDescriptor;
  readonly grantedPaths?: readonly {
    readonly kind: 'read' | 'write';
    readonly hostPath: string;
    readonly targetPath: string;
  }[];
  readonly exec: (
    request: ProcessRequest,
    context: BackendProcessContext
  ) => Promise<BackendProcessOutcome>;
  readonly files?: BackendFiles;
  readonly search?: BackendSearch;
  readonly dispose: (context: SandboxOperationContext) => Promise<void>;
}

type RecoveryDescriptor =
  | { readonly kind: 'none' }
  | {
      readonly kind: 'allocation';
      readonly id: string;
      readonly instructions: string;
      readonly lease: string;
      readonly expiresAt?: string;
    };
```

The provider's `copy` method is present exactly when its copy profiles are
non-empty. A copy profile always has `hostWorkspaceWrites: false` because a copy
cannot change the host checkout. The provider decides whether the copy's own
files accept writes.

The backend reports the location of each granted path in `grantedPaths`. Each
entry maps the resolved host path and access kind to the path in the target. The
broker verifies the reported grants against the request and exposes the entries
on the sandbox facade. The [specification][placement] defines where each grant
appears in the target.

[placement]: specification.md#escalation

`reportRecovery` supplies one aggregate descriptor before allocation. Updates
describe all outstanding allocations. The final backend's `recovery` matches the
latest descriptor. Use `none` only if there are no persistent allocations. An
update cannot replace an allocation with `none`. For an allocation, `lease`
describes the cleanup mechanism and `expiresAt` is a parseable absolute
timestamp. The provider calls `confirmCleanup` after releasing all allocations
from a failed opening. The provider then rejects the opening without allocating
anything else. Both callbacks expire when opening ends.

```typescript
interface SandboxDiagnostic {
  readonly level: 'warning';
  readonly message: string;
}

interface SandboxDiagnosticRecord extends SandboxDiagnostic {
  readonly operationId: string;
  readonly operation: SandboxOperation;
  readonly providerId?: string;
  readonly backendId?: string;
}
```

Every operation context has
`reportDiagnostic(diagnostic: SandboxDiagnostic): void`. A generation retains up
to 64 warnings of 1 to 2,048 UTF-16 code units each. Rejected and excess
warnings increment the bounded `diagnosticsDropped` counter. Reports after the
operation ends are ignored. Status exposes the retained `diagnostics` and
`diagnosticsDropped` fields.

## Provider settings

<!--
`SandboxSharedSettings`, the `settings` result field, the
`sharedSettingsSchema` callback parameter and the `allowEscalation` setting
are provisional.
-->

The provider owns the settings file. The SDK defines one TypeBox object schema
for the shared settings keys. `registerSandboxProvider` passes it to the
`configure` callback as `sharedSettingsSchema`. The callback includes
`sharedSettingsSchema.properties` at the top level of the provider's own
settings schema. The provider validates the whole file with that schema and
returns the shared values under `settings` and its own input under
`configuration`. The `settings` field belongs to the callback result.

```typescript
interface SandboxProviderRegistration<Input> {
  readonly configure: (
    context: SandboxConfigContext,
    sharedSettingsSchema: TObject
  ) => SandboxProviderConfig<Input> | Promise<SandboxProviderConfig<Input>>;
}

interface SandboxProviderConfig<Input> {
  readonly configuration: Input;
  readonly settings?: SandboxSharedSettings;
}

interface SandboxSharedSettings {
  readonly policy?: SandboxPolicy;
  readonly userShell?: ShellDialect;
  readonly cleanup?: Partial<SandboxCleanupBudgets>;
  readonly allowEscalation?: boolean;
}
```

`TObject` is the TypeBox object schema type. The SDK derives
`SandboxSharedSettings` from the schema. It reports validation failures as
`InvalidSandboxConfigError` before allocation, with the provider source and
invalid key. It omits the raw settings from user-facing diagnostics.

| Key               | Shape and default                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`          | A complete configured policy. Omission uses the SDK default below.                                                                                                                                |
| `userShell`       | A target shell dialect. If omitted, use the provider's advertised default. A user-shell command fails if neither supplies a dialect.                                                              |
| `cleanup`         | Optional `cancellationGraceMs` and `disposalTimeoutMs`. Each is an integer from 1 to 300,000. Omitted values use embedding-host defaults when supplied, then 5,000 ms and 10,000 ms respectively. |
| `allowEscalation` | A boolean. Defaults to `true`.                                                                                                                                                                    |

The SDK's default `policy` has these values.

```typescript
{
  hostWorkspaceWrites: true,
  network: false,
  hostUserData: 'read-only',
  hostSystemFiles: 'read-only'
}
```

The [specification][settings-behaviour] describes how provider support can
narrow these defaults and when passthrough applies. The default read scope
includes the [built-in toolchain roots][toolchain-roots] and read roots in the
provider's settings. A user who chooses **Always** for an eligible read grant
adds that path to the configured read roots.

[settings-behaviour]: specification.md#default-configured-policy
[toolchain-roots]: specification.md#default-toolchain-roots

## Process, files and search

```typescript
type ProcessRequest =
  | {
      readonly kind: 'argv';
      readonly executable: string;
      readonly args: readonly string[];
    }
  | {
      readonly kind: 'shell';
      readonly command: string;
      readonly dialect: ShellDialect;
    };

type ProcessExit =
  | { readonly kind: 'code'; readonly code: number }
  | {
      readonly kind: 'signal';
      readonly signal: string;
      readonly signalNumber: number;
    }
  | { readonly kind: 'unavailable' };

type Completion = 'not-started' | 'confirmed' | 'unknown' | 'not-guaranteed';

type BackendProcessOutcome =
  | { readonly kind: 'exited'; readonly exit: ProcessExit }
  | {
      readonly kind: 'cancelled';
      readonly termination: 'confirmed' | 'unconfirmed' | 'not-guaranteed';
    };
```

Both process request variants accept optional `cwd` and `env`. `env` maps
non-empty keys to strings or `null`. A null value removes a variable. Keys
exclude `=`. Paths and arguments exclude NUL. The executable must be non-empty.
Exit codes are safe integers. Signal identifiers are non-empty strings and
signal numbers are positive integers from the target.

Execution options add
`onOutput(chunk: { stream: 'stdout' | 'stderr'; data: Uint8Array }): void` and
`maxCaptureBytes`. The latter is a safe integer from 0 to 1,048,576 and defaults
to 1,048,576. The result contains `exit`, `stdout`, `stderr`,
`omittedBytes: { stdout: number; stderr: number }`, `durationMs` and optional
`violations`.

| Capability    | Backend operations                                    |
| ------------- | ----------------------------------------------------- |
| `exec`        | `exec`                                                |
| `files.read`  | `files.read.readFile`, `access`, `stat`               |
| `files.write` | `files.write.writeFile`, `access`, `mkdir`            |
| `files.list`  | `files.list.listDirectory`, `stat`                    |
| `search.find` | `search.find`                                         |
| `search.grep` | `search.grep`                                         |
| `copy`        | Provider `copy` with a matching copy profile          |
| `violations`  | Optional structured `violations` on execution results |

<!-- Violation fields are provisional in milestone 1. -->

Each violation includes an `operation: string`, an
`accessProperty: AccessProperty` and an optional `resource: string`.

The facade adds `files.updateText(path, transform, options)` when both file read
and file write are available. The synchronous transform maps strict UTF-8 text
to replacement text. The result has `before` and `after` strings. The optional
`createParents` on `writeFile` defaults to false. `readFile` and process
captures return consumer-owned bytes.

Find and grep results contain target-relative paths and `truncated: boolean`.
Find defaults to 1,000 paths. Grep defaults to 100 matching lines, regex
matching, case-sensitive matching and zero lines of context. Limits are positive
safe integers. Grep entries have a path, a one-based line number, the matching
text and arrays of preceding and following context lines. Lines exclude newline
terminators. Duplicate paths in find and duplicate path/line pairs in grep are
invalid. `truncated` is true exactly when the provider omits at least one
additional result.

Operation deadlines use finite positive milliseconds. Acquisition waiting and
broker-owned opening each default to 60,000 ms. Foreground execution defaults to
120,000 ms. File and search operations default to 30,000 ms. Acquisition
`timeoutMs` changes only the waiting deadline.

`BackendProcessContext` extends `SandboxOperationContext` with a synchronous
`onOutput(output: ProcessOutput): void`. `ProcessOutput` contains `stream` and
`data` as for the consumer callback.

Provider contexts contain `operationId`, `signal`, a Unix-epoch `deadline`,
`remainingMs()` and `cleanup`. The cleanup context has its own `deadline` and
`remainingMs(): number | undefined`. Both remaining time functions use a
monotonic clock. The [provider settings][cleanup-settings] define the cleanup
budgets. `SandboxCloseReport` contains `confirmed: boolean`,
`failures: readonly SandboxErrorInfo[]` and
`recoveries: readonly RecoveryDescriptor[]`.

[cleanup-settings]: #provider-settings

## Escalation and review

<!--
`escalate`, `EscalationRequest`, `EscalationDestination`, the
`escalation` field and `recordEscalationDecision` are provisional.
-->

Bash and PowerShell accept
`escalate?: readonly (AccessProperty | PathGrants)[]`. An escalation requires a
non-empty `justification: string`. The broker normalises listed property names
into `needed` entries and combines path entries under `paths` in the access
record. For example, `['network', { read: ['~/.npmrc'] }]` requests network
access and one file.

```typescript
type EscalationDestination =
  | {
      readonly kind: 'provider';
      readonly providerId: string;
      readonly policy: SandboxPolicy;
      readonly effectiveRestrictions: string;
    }
  | {
      readonly kind: 'host';
      readonly policy: SandboxPolicy;
      readonly effectiveRestrictions: 'none';
    };

interface EscalationRequest {
  readonly toolCallId: string;
  readonly command: string;
  readonly justification: string;
  readonly access: Access;
  readonly destination: EscalationDestination;
}

interface SandboxClient {
  recordEscalationDecision(
    context: SandboxContext,
    request: EscalationRequest,
    decision: 'allow' | 'deny'
  ): void;
}
```

Pass the request from the review source to the same client while the call is
pending. The client checks that the request matches the pending tool call in the
live session and records the extension path from the factory. A missing, expired
or mismatched request fails with `InvalidSandboxRequestError`. Conflicting
decisions fail closed. The broker uses the decision only at dispatch. The
[specification][escalation] defines negotiation and dispatch.

[escalation]: specification.md#escalation

<!--
Review source, destination and reply types and the reason literals are
provisional in milestone 1.
-->

```typescript
type ReviewUnavailableReason =
  | 'unknown-call'
  | 'unsupported-tool'
  | 'not-selected'
  | 'destination-unavailable'
  | 'invalid-source'
  | 'incompatible-protocol'
  | 'ambiguous';

type ReviewReply =
  | {
      readonly ok: true;
      readonly toolCallId: string;
      readonly sourceId: ReviewSourceId;
    }
  | {
      readonly ok: false;
      readonly toolCallId: string;
      readonly reason: ReviewUnavailableReason;
    };

interface DestinationDescription {
  readonly providerId: string;
  readonly label: string;
  readonly workspace?: SandboxWorkspace;
  readonly policy: SandboxPolicy;
}

type ShellReviewLookup =
  | { readonly ok: true; readonly source: ShellReviewSource }
  | { readonly ok: false; readonly reason: ReviewUnavailableReason };

interface ShellReviewSource {
  readonly destination: DestinationDescription;
  readonly escalation?: EscalationRequest;
  negotiateCopy(
    requirements?: SandboxRequirements
  ): Promise<SandboxNegotiation>;
  copy(options?: SandboxAcquireOptions): Promise<SandboxCopy>;
}
```

<!-- The optional workspace field is provisional in milestone 6. -->

The host destination includes its workspace. A provider destination includes its
target workspace once the broker has verified an open backend. Lookup and copy
negotiation allocate no backend.

`ReviewSourceId` is opaque. The broker issues each identity for one query from
one extension in the live session. The client resolves it through its own broker
and uses the source while the call is pending. A failed lookup includes a
`ReviewUnavailableReason`. The ledger attributes a copy to the requesting
extension.

`Sandbox.copy(options?: SandboxAcquireOptions): Promise<SandboxCopy>` uses the
acquired sandbox's workspace as the source. `SandboxCopy` contains
`sandbox: Sandbox` and `close(): Promise<SandboxCloseReport>`.

## Ledger entries

<!-- `SandboxLedgerEntry`, its fields and `/byos log` syntax are provisional. -->

```typescript
type SandboxLedgerEntry =
  | {
      readonly kind: 'escalation';
      readonly request: Omit<EscalationRequest, 'destination'> & {
        readonly destination?: EscalationDestination;
      };
      readonly outcome: 'allowed' | 'denied' | 'cancelled' | 'expired';
      readonly decider?:
        | { readonly kind: 'confirmation' }
        | { readonly kind: 'permission-extension'; readonly extension: string }
        | { readonly kind: 'configuration' };
    }
  | {
      readonly kind: 'review-copy';
      readonly toolCallId: string;
      readonly source: DestinationDescription;
      readonly policy: SandboxPolicy;
      readonly decider: {
        readonly kind: 'permission-extension';
        readonly extension: string;
      };
    }
  | {
      readonly kind: 'violation';
      readonly toolCallId?: string;
      readonly operationId: string;
      readonly providerId: string;
      readonly violations: NonNullable<ProcessResult['violations']>;
    };
```

One runtime schema defines the typed Pi session entries. The escalation entry
uses the same destination and effective restrictions as the decision function
input. When a reviewer opens a copy, the broker records the requesting extension
and the negotiated copy policy. Provider violation entries identify the
reporting provider. `/byos log [tool-call-id]` lists current-session entries and
accepts an optional tool call ID filter.

## Internal protocol

| Channel            | Operations                                              |
| ------------------ | ------------------------------------------------------- |
| `pi-byos:runtime`  | Build election, private startup, broker and diagnostics |
| `pi-byos:provider` | Descriptive provider advertisements                     |
| `pi-byos:review`   | Pending call queries and review source replies          |

```typescript
interface BuildIdentity {
  readonly buildId: string;
  readonly packageVersion: string;
  readonly extensionSource: string;
  readonly major: number;
  readonly featureLevel: number;
}

type Envelope<Payload> = BuildIdentity & {
  readonly requestId: string;
  readonly kind: 'advertisement' | 'request' | 'reply';
  readonly payload: Payload;
};
```

| Channel  | Envelope kind   | Example payload                                            |
| -------- | --------------- | ---------------------------------------------------------- |
| Runtime  | `request`       | `{ type: 'get-builds' }`                                   |
| Runtime  | `advertisement` | `{ type: 'build', candidateId }`                           |
| Runtime  | `request`       | `{ type: 'get-broker' }`                                   |
| Runtime  | `reply`         | `{ type: 'broker', candidateId, id, service }`             |
| Provider | `request`       | `{ type: 'get-providers' }`                                |
| Provider | `advertisement` | `{ type: 'provider', id, service }`                        |
| Review   | `request`       | `{ type: 'find-source', toolName, toolCallId, sessionId }` |
| Review   | `reply`         | `{ type: 'source', ok: true, toolCallId, sourceId }`       |

A review refusal replies with `ok: false` and a reason. Startup uses
`start-broker` and `connect-runtime` with direct receiver callbacks. The elected
owner receives the provider configuration and backend functions. The embedding
host receives its close function. The tool integration receives its dispatch
callbacks. The runtime offers no settings service. The shell integration query
returns `{ type: 'shell-integration' }` when an extension registers the Pi
tools.

Protocol 2 keeps the envelope and build census verb. SDK copies use the census
to detect a major mismatch before bootstrap. The [2.0 snapshot][v2] records the
current schemas. The [1.0 snapshot][v1] records the pinned contract.

[v2]: ../src/fixtures/protocol-snapshots/2.0.json
[v1]: ../src/fixtures/protocol-snapshots/1.0.json

The envelope header is fixed within a protocol major. The major is a positive
integer, and the feature level is a non-negative integer. Replies repeat the
request ID. Senders reduce offers to the lower of the two feature levels before
they reply. Broker and provider identities are opaque. Schemas annotate the
feature level for each addition. Offer reduction omits fields and values above
the shared level. A profile whose policy uses an unsupported field or value is
omitted from the offer. `/byos status` includes the chosen build identity. See
[broker discovery][broker] for compatibility rules.

[broker]: specification.md#broker-discovery

## Errors

`isSandboxError(value)` recognises the structural error union across SDK copies.
A constructor as the second argument narrows to its literal error identity. An
error includes `name`, `message`, `operation` and the applicable provider,
backend, extension or recovery context. `extensionSource` identifies the
responsible extension by its source path. An access refusal includes the
requested property and state in `detail`. A path refusal includes the access
kind, resolved host path and reason. Configuration errors include the invalid
setting key. Providers can supply an underlying cause for debugging. User-facing
diagnostics omit raw settings.

This is the complete feature level 0 error list.

| Error                                | Detail                                                                                                             |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `SandboxInitialisationError`         | Runtime or host initialisation failure                                                                             |
| `DuplicateBrokerError`               | Conflicting broker identities                                                                                      |
| `IncompatibleSandboxProtocolError`   | Both build identities for a major mismatch, or the unsupported feature and extension to update                     |
| `InvalidSandboxDeclarationError`     | Provider and rejected declaration detail                                                                           |
| `InvalidSandboxConfigError`          | Extension source and invalid setting or factory failure                                                            |
| `InvalidSandboxRequestError`         | Invalid field and rejected value                                                                                   |
| `ProviderNotFoundError`              | Selected provider ID                                                                                               |
| `ConflictingSandboxProviderError`    | Conflicting provider selections                                                                                    |
| `DuplicateProviderError`             | Duplicate provider ID                                                                                              |
| `UnsupportedSandboxCapabilityError`  | Capability, process kind, dialect, exit status or termination scope and value                                      |
| `UnsupportedSandboxPolicyError`      | Failed access property and requested state, the path that cannot be granted, or the absence of an eligible profile |
| `SandboxStartupError`                | Startup failure and outstanding recovery, when applicable                                                          |
| `StaleSandboxHandleError`            | Expired facade or runtime identity                                                                                 |
| `SandboxSessionClosingError`         | Session closure prevents new work                                                                                  |
| `SandboxPermissionDeniedError`       | Rejected operation or access                                                                                       |
| `SandboxPathNotFoundError`           | Target path or executable                                                                                          |
| `SandboxOperationError`              | Target operation failure                                                                                           |
| `SandboxCleanupError`                | Unconfirmed disposal and the complete close report when available                                                  |
| `SandboxCancelledError`              | `caller` or `shutdown`, with completion                                                                            |
| `SandboxTimeoutError`                | `deadline`, with completion                                                                                        |
| `SandboxOutputCallbackError`         | `output`, with completion                                                                                          |
| `SandboxTransportError`              | Transport failure and unknown completion                                                                           |
| `UnconfirmedSandboxTerminationError` | Termination scope and unknown completion                                                                           |
