# API and protocol appendix

This appendix specifies the shapes for the target SDK, protocol major 1 at
feature level 0. The [specification][spec] defines behaviour and identifies the
consumers of the contract. Runtime schemas define the types when the
implementation reaches this design.

[spec]: specification.md

## Public entry points

| Entry point | Operations and types                                                                                            |
| ----------- | --------------------------------------------------------------------------------------------------------------- |
| `/consumer` | `getSandbox`, `negotiateSandbox`, `Sandbox`, `SandboxRequirements`, operation types and structural error checks |
| `/provider` | `registerSandboxProvider`, provider declarations, backend operations and provider kit                           |
| `/host`     | `initialiseSandboxHost`, `closeSandboxSession`, host options and diagnostic registration                        |
| `/review`   | `findShellReviewSource` and review results                                                                      |
| `/pi-tools` | Pi tool integration factory                                                                                     |
| `/guard`    | `createSandboxGuard` and guard requirements                                                                     |
| `/testing`  | Provider conformance runner, fixtures and probe interfaces                                                      |

The package prefix is `pi-bring-your-own-sandbox`. Wire schemas, channel
constants, broker objects and identity constructors are internal.

```typescript
getSandbox(pi: SandboxHost, context: SandboxContext,
  options?: SandboxAcquireOptions): Promise<Sandbox>;
negotiateSandbox(pi: SandboxHost, context: SandboxContext,
  options?: SandboxRequirements): Promise<SandboxNegotiation>;
registerSandboxProvider<Config, Input = Config>(
  pi: SandboxHost, provider: SandboxProvider<Config>,
  options?: NoInfer<SandboxProviderRegistration<Input>>
): void;
initialiseSandboxHost(pi: SandboxHost, options: SandboxHostOptions): void;
closeSandboxSession(pi: SandboxHost, context: SandboxContext): Promise<SandboxCloseReport>;
createSandboxGuard(requirements?: SandboxRequirements & { providerId?: string }): ExtensionFactory;
```

`/host` is for embedding hosts. `SandboxHostOptions` has only
`cleanup?: Partial<SandboxCleanupBudgets>` for embedding defaults. The
[provider's cleanup settings][provider-settings] take precedence.

[provider-settings]: #provider-settings

## Requirements and profiles

<!-- `violations` is provisional in milestone 1. -->
<!--
Types `AccessProperty`, `Access`, `FileAccess` and `Profile` are provisional
in milestone 1.
-->
<!-- The policy field value types are provisional in milestone 1. -->

```typescript
type AccessProperty =
  'network' | 'hostWorkspaceWrites' | 'hostUserData' | 'hostSystemFiles';

type Access = Readonly<
  Partial<Record<AccessProperty, 'needed' | 'prevented' | 'preferred'>>
>;

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
}

interface Profile {
  readonly policy: SandboxPolicy;
  readonly capabilities: readonly Capability[];
  readonly processKinds: readonly ProcessKind[];
  readonly shells: readonly ShellDialect[];
  readonly exitStatus: ExitStatus;
  readonly terminationScope: TerminationScope;
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

This table is the level 0 access mapping. The property and policy field use the
same identifier.

| Access property and policy field | Supported values, most to least restrictive | `prevented` | `needed`                       |
| -------------------------------- | ------------------------------------------- | ----------- | ------------------------------ |
| `network`                        | `false`, `true`                             | `false`     | `true`                         |
| `hostWorkspaceWrites`            | `false`, `true`                             | `false`     | `true` on a `shared` workspace |
| `hostUserData`                   | `denied`, `read-only`, `read-write`         | `denied`    | At least `read-only`           |
| `hostSystemFiles`                | `denied`, `read-only`, `read-write`         | `denied`    | At least `read-only`           |

The specification defines the [profile ranking][access].

[access]: specification.md#configuration-and-negotiation

Metadata returned to another caller is readonly and frozen. The runtime
validates shape and profile consistency. It snapshots input data before
asynchronous work. Abort signals and synchronous callbacks retain their
identity.

## Provider contract

<!--
The provider profile fields, outside declaration and request and backend
profile fields are provisional in milestone 1.
-->

```typescript
interface SandboxProvider<Config> {
  readonly id: string;
  readonly label: string;
  readonly defaultPolicy?: SandboxPolicy;
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
  readonly outside?: {
    readonly profiles: readonly Profile[];
    readonly open: SandboxProvider<Config>['open'];
  };
}

interface SandboxOpenRequest<Config> {
  readonly generationId: string;
  readonly sessionId: string;
  readonly hostWorkspace: string;
  readonly configuration: Config;
  readonly profile: Profile;
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
  readonly recovery: RecoveryDescriptor;
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
`SandboxSharedSettings`, the `settings` result field and the
`sharedSettingsSchema` callback parameter are provisional. The
`outsideDestinations` and `outsideApproval` settings and their values
are provisional, including the new `prompt` value.
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
  readonly outsideDestinations?: readonly (
    | { readonly kind: 'provider'; readonly policy: SandboxPolicy }
    | { readonly kind: 'passthrough' }
  )[];
  readonly outsideApproval?: 'prompt' | 'permission-extension';
}
```

`TObject` is the TypeBox object schema type. The SDK derives
`SandboxSharedSettings` from the schema. It reports validation failures as
`InvalidSandboxConfigError` before allocation, with the provider source and
invalid key. It omits the raw settings from user-facing diagnostics.

| Key                   | Shape and default                                                                                                                                                                                                            |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `policy`              | A complete ordinary configured policy. If omitted, use the provider's `defaultPolicy`. If neither exists, configuration fails.                                                                                               |
| `userShell`           | A target shell dialect. If omitted, use the provider's advertised default. A user-shell command fails if neither supplies a dialect.                                                                                         |
| `cleanup`             | Optional `cancellationGraceMs` and `disposalTimeoutMs`. Each is an integer from 1 to 300,000. Omitted values use embedding-host defaults when supplied, then 5,000 ms and 10,000 ms respectively.                            |
| `outsideDestinations` | A list with at most one entry of each kind. A `provider` entry requires declared outside profiles and a complete configured policy. A `passthrough` entry enables the full-access destination. The default is an empty list. |
| `outsideApproval`     | `prompt` by default, which opens a confirmation with the provider label. `permission-extension` leaves the decision to the permission extension.                                                                             |

The [specification][settings-behaviour] describes how the broker uses the
outside settings.

[settings-behaviour]: specification.md#destinations-and-permission

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
`omittedBytes: { stdout: number; stderr: number }` and `durationMs`.

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

## Outside tool and review

<!-- `bash_outside` is provisional. -->

The Pi tool `bash_outside` takes `command: string`, `access: Access`,
`justification: string` and optional `timeout: number` in seconds. The
justification is non-empty after trimming. The [specification][destinations]
describes outside profiles and the decision boundary.

[destinations]: specification.md#destinations-and-permission

<!--
Review source, destination and reply types and the reason literals are
provisional in milestone 1.
-->

```typescript
type ReviewUnavailableReason =
  | 'unknown-call'
  | 'unsupported-tool'
  | 'destination-unavailable'
  | 'invalid-source'
  | 'incompatible-protocol';

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
  readonly workspace: SandboxWorkspace;
  readonly policy: SandboxPolicy;
}

interface ReviewSource {
  readonly destination: DestinationDescription;
  negotiateCopy(
    requirements?: SandboxRequirements
  ): Promise<SandboxNegotiation>;
  copy(options?: SandboxAcquireOptions): Promise<SandboxCopy>;
}
```

`ReviewSourceId` is opaque. Each reply correlates with one query and one pending
tool call. `findShellReviewSource` accepts the host, live context and tool call
ID. Its success result contains the broker-resolved source. Its failure result
contains a `ReviewUnavailableReason`.
`Sandbox.copy(options?: SandboxAcquireOptions): Promise<SandboxCopy>` uses the
acquired sandbox's workspace as the source. `SandboxCopy` contains
`sandbox: Sandbox` and `close(): Promise<SandboxCloseReport>`.

## Internal protocol

<!--
Channel names and the envelope and payload shapes are provisional in
milestone 1.
-->

| Channel            | Operations                                        |
| ------------------ | ------------------------------------------------- |
| `pi-byos:runtime`  | SDK build advertisements and broker discovery     |
| `pi-byos:provider` | Provider advertisements and registration exchange |
| `pi-byos:review`   | Pending call queries and review source replies    |

```typescript
interface BuildIdentity {
  readonly buildId: string;
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

| Channel  | Envelope kind   | Payload                                                                                                                     |
| -------- | --------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Runtime  | `advertisement` | `{ type: 'build' }`                                                                                                         |
| Runtime  | `request`       | `{ type: 'get-broker' }`                                                                                                    |
| Runtime  | `reply`         | `{ type: 'broker', brokerId: BrokerId }`                                                                                    |
| Provider | `advertisement` | `{ type: 'provider', providerId: ProviderId, profiles: { open: Profile[], copy: Profile[] }, outsideProfiles?: Profile[] }` |
| Review   | `request`       | `{ type: 'find-source', toolCallId: string }`                                                                               |
| Review   | `reply`         | `{ type: 'source', result: ReviewReply }`                                                                                   |

The envelope version fields are integers. The major is positive and the feature
level is non-negative. Replies repeat the request ID. Broker and provider
identities are opaque. Schemas annotate the feature level for each addition.
Offer reduction omits fields and values above the shared level. A profile whose
policy uses an unsupported field or value is omitted from the offer.
`/byos status` includes the chosen build identity. See [broker
discovery][broker] for compatibility rules.

[broker]: specification.md#broker-discovery

## Errors

`isSandboxError(value)` recognises the structural error union across SDK copies.
A constructor as the second argument narrows to its literal error identity. An
error includes `name`, `message`, `operation` and the applicable provider,
backend, extension or recovery context. A requirement failure includes the field
and rejected value. Providers can supply an underlying cause for debugging.
User-facing diagnostics omit raw settings.

This is the complete feature level 0 error list.

| Error                                | Detail                                                                                         |
| ------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `SandboxInitialisationError`         | Runtime or host initialisation failure                                                         |
| `DuplicateBrokerError`               | Conflicting broker identities                                                                  |
| `IncompatibleSandboxProtocolError`   | Both build identities for a major mismatch, or the unsupported feature and extension to update |
| `SandboxProviderMismatchError`       | Required and selected provider IDs                                                             |
| `SandboxProviderRequiredError`       | Guard requires explicit activation                                                             |
| `InvalidSandboxDeclarationError`     | Provider and rejected declaration detail                                                       |
| `InvalidSandboxConfigError`          | Extension source and invalid setting or factory failure                                        |
| `InvalidSandboxRequestError`         | Invalid field and rejected value                                                               |
| `ProviderNotFoundError`              | Selected provider ID                                                                           |
| `ConflictingSandboxProviderError`    | Conflicting provider selections                                                                |
| `DuplicateProviderError`             | Duplicate provider ID                                                                          |
| `UnsupportedSandboxCapabilityError`  | Capability, process kind, dialect, exit status or termination scope and value                  |
| `UnsupportedSandboxPolicyError`      | Access property and requested state, including any conflicting guard state                     |
| `SandboxStartupError`                | Startup failure and outstanding recovery, when applicable                                      |
| `StaleSandboxHandleError`            | Expired facade or runtime identity                                                             |
| `SandboxSessionClosingError`         | Session closure prevents new work                                                              |
| `SandboxPermissionDeniedError`       | Rejected operation or access                                                                   |
| `SandboxPathNotFoundError`           | Target path or executable                                                                      |
| `SandboxOperationError`              | Target operation failure                                                                       |
| `SandboxCleanupError`                | Unconfirmed disposal and recovery details                                                      |
| `SandboxCancelledError`              | `caller` or `shutdown`, with completion                                                        |
| `SandboxTimeoutError`                | `deadline`, with completion                                                                    |
| `SandboxOutputCallbackError`         | `output`, with completion                                                                      |
| `SandboxTransportError`              | Transport failure and unknown completion                                                       |
| `UnconfirmedSandboxTerminationError` | Termination scope and unknown completion                                                       |
