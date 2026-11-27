# API and protocol appendix

This appendix specifies protocol major 1 at feature level 0. The
[specification][spec] defines behaviour and identifies the consumers of the
contract. Runtime schemas define the types.

[spec]: specification.md

## Public entry points

| Entry point     | Operations and types                                                                   |
| --------------- | -------------------------------------------------------------------------------------- |
| `/consumer`     | `createSandboxClient`, sandbox handles, requirements and error checks                  |
| `/review`       | `createShellReviewClient`, pending shell review and escalation decisions               |
| `/provider`     | `registerSandboxProvider`, provider and backend contracts, and errors                  |
| `/provider-kit` | Shell transport, target file and search operations, cleanup, path and display helpers  |
| `/host`         | `initialiseSandboxHost`, the host handle and options, and `SandboxCloseReport`         |
| `/pi-tools`     | Pi tool integration factory, `registerShellOnlyTools` and `registerSandboxDiagnostics` |
| `/testing`      | `defineSandboxProviderTests` and `SandboxProviderTestFixture`                          |

The package prefix is `pi-bring-your-own-sandbox`. Wire schemas, channel
constants, broker objects and identity constructors are internal.

Providers can use `/provider-kit` to implement parts of the backend contract.
`ShellTransportRunner` requires a carrier that runs the helper in the provider's
target and supervises its descendants.

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
}

createShellReviewClient(pi: SandboxHost, extensionSource: string): ShellReviewClient;

interface ShellReviewClient {
  hasShellReviewRoute(): boolean;
  findShellReviewSource(
    context: SandboxContext,
    call: ReviewedToolCall
  ): ShellReviewLookup;
}

registerSandboxProvider<Config>(
  pi: SandboxHost, extensionSource: string, declaration: SandboxProvider<Config>
): void;
initialiseSandboxHost(
  pi: SandboxHost, extensionSource: string, options?: SandboxHostOptions
): SandboxHostHandle;

interface SandboxHostHandle {
  readonly close: () => Promise<SandboxCloseReport>;
}
```

Create the client in the extension factory. Pass `import.meta.filename` for
`extensionSource`. The client uses that path for build election, errors and
ledger entries. Provider registration, the Pi tools and host initialisation
register their builds through their factory entry points.

Ordinary and copy negotiation return `{ ok: false, error }` for a refusal in a
live session. A cached provider failure returns the same result on each call. An
invalid request, a stale session or a session that has begun shutdown raises an
exception. A failed `get` or `copy` rejects.

`/host` is for embedding hosts. Call `initialiseSandboxHost` from an extension
factory. The returned handle is frozen. After startup, its `close()` method
shares Pi's session shutdown and returns the same cleanup report on every call.

`SandboxHostOptions` accepts `cleanup?: Partial<SandboxCleanupBudgets>` for
embedding defaults. The [provider's cleanup settings][provider-settings] take
precedence.

[provider-settings]: #provider-settings

## Requirements and profiles

A sandbox handle exposes the verified `profile` for its allocation. Status
includes the profile after the default backend opens and reports
provider-specific boundary text separately. Provider operation contexts include
the resolved cleanup budgets.

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
  'files.read' | 'files.write' | 'files.list' | 'search.find' | 'search.grep';
type ProcessKind = 'argv' | 'shell';
type ExitStatus = 'guaranteed' | 'optional';
type TerminationScope = 'process-group' | 'workload';

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
  readonly credentialPathGrantKinds?: readonly ('read' | 'write')[];
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
`credentialPathGrantKinds` lists the subset that can reach an explicit
credential path. An omitted or empty credential list permits neither kind.

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
  readonly hostUserDataRoots?: readonly string[];
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
  readonly hostUserDataRoots?: readonly string[];
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

On an unsupported platform, the extension factory calls
`registerUnavailableSandboxProvider` with its ID, label and `unavailable`
reason.

```typescript
interface SandboxProviderUnavailability {
  readonly kind: 'unsupported-platform';
  readonly platform: string;
  readonly message: string;
}
```

Discovery lists the provider with empty open and copy profile lists and the
reason. Acquisition fails with `SandboxProviderUnavailableError`. Inspect
`detail.reason` when `detail.kind` is `provider-unavailable`.

The backend reports the location of each granted path in `grantedPaths`. Each
entry maps the resolved host path and access kind to the path in the target. The
broker verifies the reported grants against the request and exposes the entries
on the sandbox facade. The [specification][placement] defines where each grant
appears in the target.

[placement]: specification.md#escalation

For a provider profile that permits host user data access, both allocation
methods receive canonical host paths in `hostUserDataRoots`. The backend reports
the same set of roots, including an empty set if supplied. It enforces the
selected mode and credential exclusions within the roots. A backend for a
profile that denies host user data omits the field.

`reportRecovery` supplies one aggregate descriptor before allocation. Updates
describe all outstanding allocations. The final backend's `recovery` matches the
latest descriptor. Use `none` only if there are no persistent allocations. An
update cannot replace an allocation with `none`. For an allocation, `lease`
describes the cleanup mechanism and `expiresAt` is a parseable absolute
timestamp. The provider calls `confirmCleanup` after releasing all allocations
from a failed opening. The provider then rejects the opening without allocating
anything else. Both callbacks expire when opening ends.

```typescript
interface SandboxDiagnosticRecord {
  readonly message: string;
  readonly operationId: string;
  readonly operation: SandboxOperation;
  readonly providerId?: string;
  readonly backendId?: string;
}
```

Every operation context has `reportWarning(message: string): void`. A generation
retains up to 64 warnings of 1 to 2,048 UTF-16 code units each. Rejected and
excess warnings increment the bounded `diagnosticsDropped` counter. Reports
after the operation ends are ignored. Status exposes the retained `diagnostics`
and `diagnosticsDropped` fields.

## Provider registration

An available provider declares its ID, label and open and copy profiles during
the factory. The broker lists validated declarations without calling `create()`
or `configure`. A factory or configuration failure remains visible in status for
that provider throughout the generation. An unavailable provider supplies its
ID, label and platform reason in `unavailable`.

## Provider settings

The provider owns the settings file. The SDK defines one TypeBox object schema
for the shared settings keys and passes it to `configure`. A settings parser can
include its properties at the top level of the provider's own schema.
`configure` validates the settings and returns the provider's typed
`configuration` and optional shared `settings`. The SDK captures the typed
configuration for the provider's allocation methods.

```typescript
interface SandboxProviderImplementation<Config> {
  readonly configure: (
    context: SandboxConfigContext,
    sharedSettingsSchema: SharedSettingsSchema
  ) => SandboxProviderConfig<Config> | Promise<SandboxProviderConfig<Config>>;
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
  readonly persistReadRoot?: (
    context: SandboxReadRootPersistence,
    sharedSettingsSchema: SharedSettingsSchema
  ) => Promise<void>;
}

interface SandboxReadRootPersistence {
  readonly paths: readonly string[];
  readonly updateSettings: (
    filename: string,
    isValid: (settings: unknown) => boolean
  ) => Promise<void>;
}

interface SandboxProviderConfig<Config> {
  readonly configuration: Config;
  readonly settings?: SandboxSharedSettings;
}

interface SandboxSharedSettings {
  readonly policy?: SandboxPolicy;
  readonly userShell?: ShellDialect;
  readonly cleanup?: Partial<SandboxCleanupBudgets>;
  readonly allowEscalation?: boolean;
  readonly readRoots?: string[];
}
```

`SharedSettingsSchema` is the type of the shared TypeBox schema. The SDK derives
`SandboxSharedSettings` from the schema. It reports validation failures as
`InvalidSandboxConfigError` before allocation, with the provider source and
invalid key. It omits the raw settings from user-facing diagnostics.

| Key               | Shape and default                                                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`          | A complete configured policy. Omission uses the SDK default below.                                                                                                                                |
| `userShell`       | A target shell dialect. If omitted, use the provider's advertised default. A user-shell command fails if neither supplies a dialect.                                                              |
| `cleanup`         | Optional `cancellationGraceMs` and `disposalTimeoutMs`. Each is an integer from 1 to 300,000. Omitted values use embedding-host defaults when supplied, then 5,000 ms and 10,000 ms respectively. |
| `allowEscalation` | A boolean. Defaults to `true`.                                                                                                                                                                    |
| `readRoots`       | Additional host user data roots. Paths must be absolute, `~` or start with `~/`. Defaults to an empty list.                                                                                       |

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
narrow these defaults and when passthrough applies. Both permitted host user
data modes use the [built-in toolchain roots][toolchain-roots] and the paths in
`readRoots`. A user who chooses **Always** for an eligible read grant adds that
path to `readRoots`.

[settings-behaviour]: specification.md#default-configured-policy
[toolchain-roots]: specification.md#default-toolchain-roots

For **Always**, the elected broker calls the selected provider's
`persistReadRoot` callback with the approved canonical paths. The callback
awaits one call to `updateSettings` with the provider's global settings filename
and a validator for the whole file. The file must be a regular file in Pi's
effective agent directory outside the checkout. The SDK rereads the file,
validates the original and updated settings, deduplicates the roots, and
replaces the file atomically. Concurrent approvals from separate sessions can
lose one update.

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

type Completion = 'not-started' | 'confirmed' | 'unknown';

type BackendProcessOutcome =
  | { readonly kind: 'exited'; readonly exit: ProcessExit }
  | {
      readonly kind: 'cancelled';
      readonly termination: 'confirmed' | 'unconfirmed';
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
to 1,048,576. The result contains `exit`, `stdout`, `stderr`, and
`omittedBytes: { stdout: number; stderr: number }`.

Every backend implements `exec`. A provider with copy profiles implements `copy`
for the host checkout and its own backends from the same session and generation.

| Capability    | Backend operations                         |
| ------------- | ------------------------------------------ |
| `files.read`  | `files.read.readFile`, `access`, `stat`    |
| `files.write` | `files.write.writeFile`, `access`, `mkdir` |
| `files.list`  | `files.list.listDirectory`, `stat`         |
| `search.find` | `search.find`                              |
| `search.grep` | `search.grep`                              |

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
`escalation` field and `recordDecision` are provisional.
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
```

Call the review source's `recordDecision` method while the escalation is
pending. The broker binds the method to the exact call and attributes the
decision to the requesting extension. A late decision fails with
`InvalidSandboxRequestError`. Repeating the same choice has no effect.
Conflicting choices fail closed. The broker consumes the decision at dispatch.
The [specification][escalation] defines negotiation and dispatch.

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
  readonly signal?: AbortSignal;
  readonly recordDecision?: (decision: EscalationDecision) => void;
  negotiateCopy(
    requirements?: SandboxRequirements
  ): Promise<SandboxNegotiation>;
  copy(options?: SandboxAcquireOptions): Promise<SandboxCopy>;
}
```

An escalation source includes its decision method and signal. The signal aborts
at expiry, revocation or completion of the pending decision. Pass it to review
work such as the model request and permission dialogue.

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
    };
```

One runtime schema defines the typed Pi session entries. The escalation entry
uses the same destination and effective restrictions as the decision function
input. When a reviewer opens a copy, the broker records the requesting extension
and the negotiated copy policy. `/byos log [tool-call-id]` lists entries for the
current session and accepts an optional tool call ID filter.

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
`start-broker` and `connect-runtime` with direct receiver callbacks.

| Participant      | Private handoff                                                                                                                                                                                                                                                                                                                         |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Runtime provider | Supplies its declaration and build identity. An available provider also supplies `configure(context)`, which returns shared `settings?`, `open`, `copy?` and `persistReadRoot?`. The registering SDK keeps typed configuration in the allocation closures. The broker offers Always only when the result includes a persistence method. |
| Embedding host   | Receives the broker's close function.                                                                                                                                                                                                                                                                                                   |
| Tool integration | Receives the callbacks for dispatching shell calls.                                                                                                                                                                                                                                                                                     |

The shell integration query returns `{ type: 'shell-integration' }` when an
extension registers the Pi tools.

SDK copies use the build census to detect a major mismatch before bootstrap. The
[1.0 snapshot][v1] records the draft schemas until the first release. Earlier
drafts also claimed protocol 1.0 and are incompatible with the release. Upgrade
every extension that bundles BYOS together, then restart Pi to load the released
builds in a fresh process.

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
