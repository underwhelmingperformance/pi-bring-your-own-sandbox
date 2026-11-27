import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';

import type {
	errorDetailSchema,
	operationSchema,
	ordinaryErrorNameSchema
} from './error-schema.js';
import type {
	EscalationDecision,
	EscalationRequest
} from './escalation-ledger.js';
import type { DestinationDescription } from './escalation-ledger.js';
import type {
	PathGrants,
	Policy,
	Profile,
	SandboxProviderUnavailability
} from './policy-model.js';
import type { ReviewUnavailableReason } from './review-identities.js';
export type {
	Access,
	AccessProperty,
	PathGrants,
	Profile
} from './policy-model.js';
import type { ProfileRequirements } from './profile-negotiation.js';
import type {
	environmentSchema,
	sharedSettingsSchema
} from './request-schemas.js';
import type { processExitSchema } from './result-schemas.js';
import type { shellSchema, terminationScopeSchema } from './schemas.js';

/**
Pi's event bus, lifecycle handlers and diagnostic writers, supplied by a live
extension factory. Cleanup warnings use messages and durable entries before
Pi invalidates the runtime.
*/
export type SandboxHost = Pick<
	ExtensionAPI,
	'events' | 'on' | 'sendMessage' | 'appendEntry' | 'getActiveTools'
>;
/**
Execution defaults supplied by an embedding host. Each runtime requires its
own event bus.
*/
export interface SandboxHostOptions {
	/**
	Cleanup defaults used unless the activated provider supplies overrides.
	*/
	readonly cleanup?: Partial<SandboxCleanupBudgets>;
	/**
	Absolute path to the embedding host's Pi agent directory. The SDK uses
	Pi's standard resolution when the host omits this option.
	*/
	readonly agentDirectory?: string;
}
/**
Closes the embedded runtime's sandbox session after startup. Repeated calls
return the cleanup report from the same shutdown operation.
*/
export interface SandboxHostHandle {
	readonly close: () => Promise<SandboxCloseReport>;
}

/**
Live Pi context required for generation identity and workspace paths. Pass the
context supplied by Pi so its runtime validity checks remain active.
*/
export interface SandboxContext {
	readonly cwd: string;
	readonly sessionManager: Pick<
		ExtensionContext['sessionManager'],
		'getSessionId'
	>;
}

/**
Command languages that a provider can advertise independently of argv
execution.
*/
export type ShellDialect = Static<typeof shellSchema>;
/**
Processes that must stop before execution completes or cancellation is
acknowledged. `process-group` covers the direct process and its supervised
POSIX group. `workload` also covers descendants that change group or session.
*/
export type TerminationScope = Static<typeof terminationScopeSchema>;
export type SandboxPolicy = Policy;

/**
Target filesystem metadata. Paths use the target flavour.
*/
export interface SandboxWorkspace {
	/**
	Absolute target workspace path, also used to resolve relative operation
	paths.
	*/
	readonly root: string;

	/**
	Lexical path rules for the target, independent of the host OS.
	*/
	readonly pathFlavor: 'posix' | 'win32';

	/**
	Whether the target exposes the live checkout or a private copy.
	*/
	readonly relationship: 'shared' | 'copied';

	/**
	Absolute target home directory, when the provider exposes it.
	*/
	readonly home?: string;

	/**
	Absolute target root for ordinary files from the host home directory.
	Required when the selected profile permits host user data reads.
	*/
	readonly hostUserDataRoot?: string;

	/**
	Preferred target dialect, when it is also advertised in capabilities.
	*/
	readonly defaultShell?: ShellDialect;
}

/**
Non-secret cleanup instructions covering every resource from one opening.
Report an aggregate descriptor before creating resources. Each update replaces
the previous descriptor and must still cover every outstanding resource.
`none` is valid only when the provider creates no independently persistent
allocation.
*/
export type RecoveryDescriptor =
	| { readonly kind: 'none' }
	| {
			readonly kind: 'allocation';
			/**
			Non-secret resource identity used by the provider's recovery procedure.
			*/
			readonly id: string;
			/**
			Steps for releasing this allocation without a live SDK session.
			Exclude credentials and other secrets.
			*/
			readonly instructions: string;
			/**
			Description of the provider's lease or cleanup mechanism, not an identity. Specify
			whether automatic expiry or manual recovery releases abandoned resources.
			*/
			readonly lease: string;
	  };

/**
Cancellation and deadline settings for one consumer call. Timeouts are
finite, positive milliseconds and include time spent waiting for queued
work.
*/
export interface SandboxOperationOptions {
	/**
	Cancels this call. Cancelling an acquisition waiter does not cancel
	shared startup.
	*/
	readonly signal?: AbortSignal;

	/**
	Deadline duration in milliseconds. Defaults: acquire 60,000, exec
	120,000, files and search 30,000.
	*/
	readonly timeoutMs?: number;
}

/**
Requirements checked against the selected, shared backend. Requirements do
not select another provider or reconfigure an existing backend.
*/
export type SandboxRequirements = ProfileRequirements;

export interface SandboxAcquireOptions
	extends SandboxOperationOptions, SandboxRequirements {}

/**
Result of negotiating acquisition requirements without provisioning: the
policy that a matching acquisition would open, or the typed error that it
would throw.
*/
export type SandboxNegotiation =
	| { readonly ok: true; readonly profile: Profile }
	| { readonly ok: false; readonly error: SandboxErrorInfo };

/**
Broker-supplied operation identity, composed cancellation and remaining
monotonic budget. Unix-epoch deadlines are diagnostic metadata.
*/
export interface SandboxOperationContext {
	/**
	Remaining execution allowance in milliseconds, calculated from monotonic time
	at each call and clamped to zero. Use this allowance to enforce deadlines.
	Remote transports must subtract elapsed transit and queue time without
	assuming a shared monotonic origin.
	*/
	readonly remainingMs: () => number;
	/**
	Report a bounded warning outside workload output. Messages must be suitable
	for user display and must not include credentials. The callback is
	synchronous; reports after the operation finishes are ignored.
	*/
	readonly reportWarning: (message: string) => void;
	/**
	Stable cleanup context. Its deadline becomes available before cancellation
	listeners run and remains unchanged for that cancellation. Disposal receives
	its cleanup deadline immediately.
	*/
	readonly cleanup: SandboxCleanupContext;

	/**
	Resolved durations for this generation. A context from an older SDK can omit them.
	*/
	readonly cleanupBudgets?: SandboxCleanupBudgets;
	/**
	Unique identity for correlating this invocation with provider
	diagnostics.
	*/
	readonly operationId: string;

	/**
	Combines caller cancellation, deadline, session shutdown and output
	callback failure.
	*/
	readonly signal: AbortSignal;

	/**
	Absolute Unix-epoch deadline in milliseconds for diagnostics. Enforce the
	remaining monotonic allowance and observe the signal.
	*/
	readonly deadline: number;
}

/**
The deadline for stopping and acknowledging provider work after cancellation.
*/
export interface SandboxCleanupContext {
	/**
	Remaining cleanup allowance from monotonic time. Undefined while execution is
	active; cancellation publishes the budget before abort listeners run.
	Repeated calls consume the same allowance, including sequential cleanup work.
	*/
	readonly remainingMs: () => number | undefined;
	/**
	Absolute Unix-epoch deadline in milliseconds. Undefined while execution is
	active; cancellation publishes this value before aborting the signal.
	*/
	readonly deadline: number | undefined;
}

/**
Bounded cleanup durations fixed when a generation reads trusted configuration.
Each value is an integer from 1 to 300,000 milliseconds.
*/
export interface SandboxCleanupBudgets {
	/**
	Time allowed to confirm termination after cancellation. Defaults to 5,000.
	*/
	readonly cancellationGraceMs: number;
	/**
	Time allowed for backend disposal. Defaults to 10,000.
	*/
	readonly disposalTimeoutMs: number;
}

/**
A retained warning with broker-supplied operation and resource identities.
*/
export interface SandboxDiagnosticRecord {
	readonly message: string;
	/**
	Identity of the operation that emitted the warning.
	*/
	readonly operationId: string;
	/**
	Provider operation associated with the warning.
	*/
	readonly operation: SandboxOperation;
	/**
	Selected provider, when known.
	*/
	readonly providerId?: string;
	/**
	Allocated backend, when known.
	*/
	readonly backendId?: string;
}

/**
Opening context with recovery reporting for allocations that may outlive a
failed open.
*/
export interface SandboxOpenContext extends SandboxOperationContext {
	/**
	Publish aggregate cleanup metadata before allocation. Each update replaces
	the previous descriptor and must cover every outstanding resource. The
	returned backend must include the final descriptor unchanged. An allocation
	descriptor cannot be replaced with `none`; acknowledge cleanup before
	rejecting through `confirmCleanup()` instead.
	*/
	readonly reportRecovery: (recovery: RecoveryDescriptor) => void;

	/**
	Acknowledge release of every allocation from this opening immediately
	before rejecting it. After this call, opening must neither allocate more
	resources nor return a backend. Both callbacks expire when opening completes.
	*/
	readonly confirmCleanup: () => void;
}

/**
Overrides for the target runtime environment. Strings set values; `null`
removes variables. Unspecified keys preserve provider defaults. External
providers receive no implicit host credentials.
*/
export type ProcessEnvironment = Readonly<Static<typeof environmentSchema>>;

interface ProcessLocation {
	/**
 Target working directory. Relative paths resolve from the workspace root.
 */
	readonly cwd?: string;
	/**
 Overrides for target environment entries; omitted keys preserve provider defaults.
 */
	readonly env?: ProcessEnvironment;
}

/**
Run an executable with literal argument values, or interpret a command in an
explicit shell dialect. Paths and working directories use target semantics;
relative paths resolve from the workspace root. For argv requests, providers
may use a fixed, trusted transport shell with a validated, lossless encoding.
Transport must preserve executable lookup, argument values and boundaries,
working directory and target environment semantics. Caller data must not become
transport shell syntax or control bootstrap execution. See the process
execution contract for details.
*/
export type ProcessRequest = ProcessLocation &
	(
		| {
				readonly kind: 'argv';
				readonly executable: string;
				readonly args: readonly string[];
				readonly command?: never;
				readonly dialect?: never;
		  }
		| {
				readonly kind: 'shell';
				readonly command: string;
				readonly dialect: ShellDialect;
				readonly executable?: never;
				readonly args?: never;
		  }
	);

/**
One ordered byte chunk from stdout or stderr. No text decoding has occurred.
*/
export interface ProcessOutput {
	/**
	Identifies the source pipe without merging stdout and stderr.
	*/
	readonly stream: 'stdout' | 'stderr';

	/**
	Bytes valid for the synchronous callback. Copy retained data because
	providers may reuse buffers afterwards.
	*/
	readonly data: Uint8Array;
}

/**
Execution settings for capture and synchronous streaming, in addition to
cancellation.
*/
export interface ProcessOptions extends SandboxOperationOptions {
	/**
	Combined stdout/stderr capture bound, from 0 to 1,048,576 bytes. The
	default is 1,048,576; excess output is drained.
	*/
	readonly maxCaptureBytes?: number;

	/**
	Called synchronously in delivery order with independent byte copies.
	Throwing cancels execution; returning a promise is invalid.
	*/
	readonly onOutput?: (output: ProcessOutput) => void;
}

/**
Provider execution context. Cancellation requires termination
acknowledgement.
*/
export interface BackendProcessContext extends SandboxOperationContext {
	/**
	Deliver ordered byte chunks synchronously. The provider may reuse each
	buffer after this callback returns.
	*/
	readonly onOutput: (output: ProcessOutput) => void;
}

/**
Exit details after confirmed foreground completion. Optional-status providers
may report unavailable details. A non-zero code is a process result, not an SDK
error. Signal termination includes the target OS signal number so consumers
can derive a shell status without using the host signal table.
*/
export type ProcessExit = Readonly<Static<typeof processExitSchema>>;

/**
Provider execution result under its declared termination scope. Normal results
include the command's exit details. Confirmed cancellation certifies termination
within `process-group` or `workload`; it never means merely submitting a signal.
Descendants
outside a guaranteed scope may continue changing permitted files after the call
returns. Unconfirmed termination within a promised scope makes the backend
unhealthy; the operation must not be replayed.
*/
export type BackendProcessOutcome =
	| {
			readonly kind: 'exited';
			readonly exit: ProcessExit;
	  }
	| {
			readonly kind: 'cancelled';
			readonly termination: 'confirmed' | 'unconfirmed';
	  };

/**
Captured process output and exit status after foreground completion is
confirmed.
*/
export interface ProcessResult {
	/**
Exit code, signal or explicitly unavailable details after confirmed
completion. Non-zero codes remain successful SDK results.
	*/
	readonly exit: ProcessExit;

	/**
	Captured bytes from stdout, owned by the consumer.
	*/
	readonly stdout: Uint8Array;

	/**
	Captured bytes from stderr, owned by the consumer.
	*/
	readonly stderr: Uint8Array;

	/**
	Byte counts drained beyond the shared capture bound, separated by source
	stream.
	*/
	readonly omittedBytes: {
		readonly stdout: number;
		readonly stderr: number;
	};

	/**
	Non-negative execution duration measured with a monotonic clock.
	*/
}

/**
Filesystem entry kinds; directory listings report links without following
them.
*/
export type FileKind = 'file' | 'directory' | 'symlink' | 'other';

/**
Metadata for the resolved target. A final symlink is followed; a dangling
link fails.
*/
export interface FileStat {
	/**
	Resolved target kind; final symlinks are followed.
	*/
	readonly kind: Exclude<FileKind, 'symlink'>;

	/**
	Non-negative safe integer in bytes.
	*/
	readonly size: number;
}

/**
An immediate directory child. Its basename is relative to the requested
directory.
*/
export interface DirectoryEntry {
	/**
	A single basename, without a host or target directory prefix.
	*/
	readonly name: string;

	/**
	Entry kind without following a final symlink.
	*/
	readonly kind: FileKind;
}

/**
Read operations required together for the `files.read` capability.
*/
export interface BackendFileReader {
	/**
	Read the complete file as bytes, resolving links within the effective
	policy boundary.
	*/
	readonly readFile: (
		path: string,
		context: SandboxOperationContext
	) => Promise<Uint8Array>;

	/**
	Check readability of the resolved target; reject missing or denied paths
	with distinct errors.
	*/
	readonly access: (
		path: string,
		context: SandboxOperationContext
	) => Promise<void>;

	/**
	Follow the final symlink and report metadata for the target.
	*/
	readonly stat: (
		path: string,
		context: SandboxOperationContext
	) => Promise<FileStat>;
}

/**
Mutation operations required together for the `files.write` capability.
Providers must enforce effective policy after resolving filesystem links.
*/
export interface BackendFileWriter {
	/**
	Replace the complete file with the supplied bytes. Do not create missing
	parents implicitly.
	*/
	readonly writeFile: (
		path: string,
		content: Uint8Array,
		context: SandboxOperationContext
	) => Promise<void>;

	/**
	Check write access to the resolved target under effective policy.
	*/
	readonly access: (
		path: string,
		context: SandboxOperationContext
	) => Promise<void>;

	/**
	Create the requested directory and missing parents.
	*/
	readonly mkdir: (
		path: string,
		context: SandboxOperationContext
	) => Promise<void>;
}

/**
Directory operations required together for the `files.list` capability.
*/
export interface BackendDirectoryReader {
	/**
	Return immediate child basenames and entry kinds without following child
	symlinks.
	*/
	readonly listDirectory: (
		path: string,
		context: SandboxOperationContext
	) => Promise<readonly DirectoryEntry[]>;

	/**
	Follow the final symlink and report metadata for the target.
	*/
	readonly stat: (
		path: string,
		context: SandboxOperationContext
	) => Promise<FileStat>;
}

/**
Optional provider operation groups. Presence must match advertised
capabilities in both directions.
*/
export interface BackendFiles {
	/**
	Present exactly when the backend advertises `files.read`.
	*/
	readonly read?: BackendFileReader;

	/**
	Present exactly when the backend advertises `files.write`.
	*/
	readonly write?: BackendFileWriter;

	/**
	Present exactly when the backend advertises `files.list`.
	*/
	readonly list?: BackendDirectoryReader;
}

/**
Glob search under a target directory using provider-documented matching rules.
*/
export interface FindRequest {
	/**
	Glob interpreted by the provider.
	*/
	readonly pattern: string;

	/**
	Target search root; omission uses the workspace root.
	*/
	readonly path?: string;

	/**
	Positive safe integer maximum. Defaults to 1,000.
	*/
	readonly limit?: number;
}

/**
Matching relative paths in provider-defined order.
*/
export interface FindResult {
	/**
	Matching paths relative to the search root. Directory paths end in the
	target path separator; other paths have no trailing separator.
	*/
	readonly paths: readonly string[];

	/**
	True only when at least one additional path was omitted.
	*/
	readonly truncated: boolean;
}

/**
Line search using ripgrep regex and glob rules. Defaults to case-sensitive
regex matching.
*/
export interface GrepRequest {
	/**
Regex text, or literal text when `literal` is true.
	*/
	readonly pattern: string;

	/**
	Target search root; omission uses the workspace root.
	*/
	readonly path?: string;

	/**
	Optional ripgrep file glob. The glob can override an ignore rule.
	*/
	readonly glob?: string;

	/**
	Use literal matching. Defaults to false.
	*/
	readonly literal?: boolean;

	/**
	Use case-insensitive matching. Defaults to false.
	*/
	readonly ignoreCase?: boolean;

	/**
	Non-negative safe integer of surrounding lines per match. Defaults to
	zero.
	*/
	readonly context?: number;

	/**
	Positive safe integer maximum matching lines. Defaults to 100.
	*/
	readonly limit?: number;
}

/**
One matching line and adjacent context from a target file. Text excludes
newline terminators.
*/
export interface GrepMatch {
	/**
	File path relative to the search root.
	*/
	readonly path: string;

	/**
	One-based line number in the target file.
	*/
	readonly line: number;

	/**
	Matching line without its newline terminator.
	*/
	readonly text: string;

	/**
	Available preceding lines in file order, without newline terminators.
	*/
	readonly before: readonly string[];

	/**
	Available following lines in file order, without newline terminators.
	*/
	readonly after: readonly string[];
}

/**
Matching lines in provider-defined order.
*/
export interface GrepResult {
	/**
	One result per matching line, even when a pattern matches several times
	on that line.
	*/
	readonly matches: readonly GrepMatch[];

	/**
	True only when at least one additional matching line was omitted.
	*/
	readonly truncated: boolean;
}

/**
Optional provider search operations. Each method requires its corresponding
advertised capability.
*/
export interface BackendSearch {
	/**
	Find matching paths without following directory symlinks.
	*/
	readonly find?: (
		request: FindRequest,
		context: SandboxOperationContext
	) => Promise<FindResult>;

	/**
	Find matching lines, skipping binary files and directory symlinks.
	*/
	readonly grep?: (
		request: GrepRequest,
		context: SandboxOperationContext
	) => Promise<GrepResult>;
}

/**
Generation-scoped allocation request with configuration already validated by
the provider.
*/
export interface SandboxOpenRequest<Config = unknown> {
	/**
	Broker generation that owns the allocation and eventual cleanup.
	*/
	readonly generationId: string;

	/**
	Pi session identity used for provider correlation.
	*/
	readonly sessionId: string;

	/**
	Host workspace path for providers that copy or share files; it is not a
	target path.
	*/
	readonly hostWorkspace: string;

	/**
	Complete policy that the allocated backend must satisfy.
	*/
	readonly profile: Profile;
	readonly paths?: PathGrants;

	/**
	Canonical host roots for ordinary access to host user data. Enforce the
	profile's access mode within these roots and exclude credential locations.
	*/
	readonly hostUserDataRoots?: readonly string[];

	/**
	Resolved durations for the new allocation. Older brokers can omit them.
	*/
	readonly cleanupBudgets?: SandboxCleanupBudgets;

	/**
	Provider-specific validated value; never include it in routine
	diagnostics.
	*/
	readonly configuration: Config;
}

/**
Live runtime context and shared startup budget supplied to configuration
resolvers. Cancelling an individual acquisition does not cancel this resolver.
*/
export interface SandboxConfigContext extends SandboxOperationContext {
	/**
	Pi context for the runtime whose configuration is being resolved.
	*/
	readonly pi: SandboxContext;
	/**
	The effective absolute Pi agent directory for global settings.
	*/
	readonly agentDirectory: string;
}
/**
The schema for settings shared across providers.
*/
export type SharedSettingsSchema = typeof sharedSettingsSchema;

/**
Provider-owned settings for the configured policy and execution defaults.
*/
export type SandboxSharedSettings = Readonly<Static<SharedSettingsSchema>>;

/**
An approved set of canonical host paths. Call and await `updateSettings`
once. The SDK rereads the selected file and validates the old and new values
before replacing it.
*/
export interface SandboxReadRootPersistence {
	readonly paths: readonly string[];
	readonly updateSettings: (
		filename: string,
		isValid: (settings: unknown) => boolean
	) => Promise<void>;
}

/**
Declare a provider during a Pi extension factory. The SDK constructs an
available implementation when it needs to configure the provider. An
unavailable provider remains visible in diagnostics.
*/
export type SandboxProvider<Config> =
	AvailableSandboxProvider<Config> | UnavailableSandboxProvider;

interface UnavailableSandboxProvider {
	readonly id: string;
	readonly label: string;
	readonly unavailable: SandboxProviderUnavailability;
}

export interface AvailableSandboxProvider<Config> {
	readonly id: string;
	readonly label: string;
	readonly profiles: {
		readonly open: readonly Profile[];
		readonly copy: readonly Profile[];
	};
	readonly create: () => SandboxProviderImplementation<Config>;
}

export interface SandboxProviderImplementation<Config> {
	/**
	Read and validate trusted provider settings without allocating a backend.
	*/
	readonly configure: (
		context: SandboxConfigContext,
		schema: SharedSettingsSchema
	) => SandboxProviderConfig<Config> | Promise<SandboxProviderConfig<Config>>;
	/**
	Allocate a backend for the selected profile. Report recovery before allocation
	and release any resources if opening fails.
	*/
	readonly open: (
		request: SandboxOpenRequest<Config>,
		context: SandboxOpenContext
	) => Promise<SandboxBackend>;
	/**
	Create an independent copy of the supplied source. Required when the
	declaration includes copy profiles.
	*/
	readonly copy?: (
		request: SandboxOpenRequest<Config> & {
			readonly source: SandboxCopySource;
		},
		context: SandboxOpenContext
	) => Promise<SandboxBackend>;
	/**
	Save an approved read grant in the provider's global settings file.
	*/
	readonly persistReadRoot?: (
		context: SandboxReadRootPersistence,
		schema: SharedSettingsSchema
	) => Promise<void>;
}

export interface SandboxProviderConfig<Config> {
	readonly configuration: Config;
	readonly settings?: SandboxSharedSettings;
}

/**
What a provider copies: the host workspace, or one of its own open backends.
*/
export type SandboxCopySource =
	| { readonly kind: 'host' }
	| { readonly kind: 'backend'; readonly backend: SandboxBackend };

/**
A private copy owned by its caller. The copy is not shared with other
consumers. Close it when it is no longer needed; closing the session also
disposes it.
*/
export interface SandboxCopy {
	readonly sandbox: Sandbox;
	readonly close: () => Promise<SandboxCloseReport>;
}

/**
A pending Pi tool call, identified by the tool's name and the call's ID.
*/
export interface ReviewedToolCall {
	readonly toolName: string;
	readonly toolCallId: string;
}

/**
The destination of a pending shell tool call. A reviewer can copy the files
that the command will see, but cannot run anything in the destination itself.
*/
export interface ShellReviewSource {
	readonly destination: DestinationDescription;
	readonly escalation?: EscalationRequest;
	/**
	Cancels review work when the pending escalation ends.
	*/
	readonly signal?: AbortSignal;
	readonly recordDecision?: (decision: EscalationDecision) => void;
	readonly negotiateCopy: (
		requirements?: SandboxRequirements
	) => Promise<SandboxNegotiation>;
	/**
	Open a private copy of the destination. The copy is checked against the
	options in the caller's SDK, and a copy that fails the check is closed.
	*/
	readonly copy: (options?: SandboxAcquireOptions) => Promise<SandboxCopy>;
}

export type ShellReviewLookup =
	| { readonly ok: true; readonly source: ShellReviewSource }
	| { readonly ok: false; readonly reason: ReviewUnavailableReason };

/**
Provider-owned target execution environment. Consumers receive a broker
facade. All operations must respect cancellation, deadlines and effective
policy; paths refer to the target.
*/
export interface GrantedPath {
	readonly kind: 'read' | 'write';
	readonly hostPath: string;
	readonly targetPath: string;
}

export interface SandboxBackend {
	/**
	Provider-assigned identity for the allocated target.
	*/
	readonly id: string;

	/**
	Absolute target paths, path flavour and synchronisation relationship.
	*/
	readonly workspace: SandboxWorkspace;

	readonly profile: Profile;
	readonly grantedPaths?: readonly GrantedPath[];
	/**
	The host user data roots enforced by this backend. Return the requested
	roots when the broker supplies them, including an empty list.
	*/
	readonly hostUserDataRoots?: readonly string[];
	readonly policyDescription: string;

	/**
	Non-secret cleanup instructions for resources that may outlive the
	broker.
	*/
	readonly recovery: RecoveryDescriptor;

	/**
	Run a command under the advertised termination scope. Normal completion
	requires the command's result and termination within any promised scope.
	Detached jobs are excluded as specified by `BackendProcessOutcome`.
	*/
	readonly exec: (
		request: ProcessRequest,
		context: BackendProcessContext
	) => Promise<BackendProcessOutcome>;

	/**
	Implemented file groups, consistent with advertised capabilities.
	*/
	readonly files?: BackendFiles;

	/**
	Implemented search methods, consistent with advertised capabilities.
	*/
	readonly search?: BackendSearch;

	/**
	Release generation-owned resources. Resolve only after cleanup is
	confirmed; respect the supplied shutdown deadline. Repeated and overlapping
	calls must share cleanup without repeating resource-release effects.
	*/
	readonly dispose: (context: SandboxOperationContext) => Promise<void>;
}

/**
Consumer filesystem facade. Methods always exist and reject unsupported
capabilities. Paths use target semantics. Mutations share the generation
queue; commands execute outside it.
*/
export interface SandboxFiles {
	/**
	Read complete target bytes. Defaults to a 30,000 ms deadline.
	*/
	readonly readFile: (
		path: string,
		options?: SandboxOperationOptions
	) => Promise<Uint8Array>;

	/**
	Snapshot input bytes and replace the complete file through the shared
	mutation queue. Create missing parent directories before writing.
	*/
	readonly writeFile: (
		path: string,
		content: Uint8Array,
		options?: SandboxOperationOptions
	) => Promise<void>;

	/**
	Create missing parents through the shared mutation queue.
	*/
	readonly mkdir: (
		path: string,
		options?: SandboxOperationOptions
	) => Promise<void>;

	/**
	Check read or write access using the matching backend group and target
	policy.
	*/
	readonly access: (
		path: string,
		mode: 'read' | 'write',
		options?: SandboxOperationOptions
	) => Promise<void>;

	/**
	Follow the final symlink, using the read group when available and the
	list group otherwise.
	*/
	readonly stat: (
		path: string,
		options?: SandboxOperationOptions
	) => Promise<FileStat>;

	/**
	List immediate children without following child symlinks.
	*/
	readonly listDirectory: (
		path: string,
		options?: SandboxOperationOptions
	) => Promise<readonly DirectoryEntry[]>;
}

/**
Consumer search facade. Unsupported search capabilities reject before
provider invocation.
*/
export interface SandboxSearch {
	/**
	Return matching relative paths under the requested
	target root.
	*/
	readonly find: (
		request: FindRequest,
		options?: SandboxOperationOptions
	) => Promise<FindResult>;

	/**
	Return matching lines using the SDK's ripgrep search rules.
	*/
	readonly grep: (
		request: GrepRequest,
		options?: SandboxOperationOptions
	) => Promise<GrepResult>;
}

/**
Consumer facade tied to one live Pi runtime and session generation. Each
call checks liveness. Resource disposal remains the responsibility of the
broker.
*/
export interface Sandbox {
	/**
	Selected provider identity, including `passthrough` for host execution.
	*/
	readonly providerId: string;

	/**
	Allocated target identity shared by consumers in this generation.
	*/
	readonly backendId: string;

	/**
	Lifetime boundary checked before every operation.
	*/
	readonly generationId: string;

	/**
	Readonly snapshot of target paths and workspace synchronisation.
	*/
	readonly workspace: SandboxWorkspace;
	readonly grantedPaths?: readonly GrantedPath[];

	/**
	Verified policy and operations for this allocation.
	*/
	readonly profile: Profile;

	/**
	Run argv or an explicit shell command with bounded capture and
	cancellation acknowledgement.
	*/
	readonly exec: (
		request: ProcessRequest,
		options?: ProcessOptions
	) => Promise<ProcessResult>;

	/**
	Always-present facade; unsupported methods reject before provider
	invocation.
	*/
	readonly files: SandboxFiles;

	/**
	Always-present facade; unsupported methods reject before provider
	invocation.
	*/
	readonly search: SandboxSearch;

	/**
	Copy this sandbox's workspace into an independent allocation. The provider
	must declare a copy profile that meets the requirements.
	*/
	readonly copy: (options?: SandboxAcquireOptions) => Promise<SandboxCopy>;
}

/**
The first cancellation source observed by the broker; later sources do not
replace it.
*/
export type CancellationReason = 'caller' | 'deadline' | 'shutdown' | 'output';
/**
Whether provider work began and whether completion was acknowledged.
`not-started` excludes provider invocation. For execution, `confirmed` excludes
later effects within the backend's declared termination scope. File mutations
require that all effects have stopped.
`unknown` requires quarantining the backend for mutations or execution.
*/
export type OperationCompletion = 'not-started' | 'confirmed' | 'unknown';
/**
SDK operations recorded in error context and provider operation identities.
*/
export type SandboxOperation = Static<typeof operationSchema>;

/**
Identifies the operation and resources associated with an error.
*/
export interface SandboxErrorContext {
	/**
	The SDK operation that failed.
	*/
	readonly extensionSource?: string;
	readonly detail?: Readonly<Static<typeof errorDetailSchema>>;
	readonly operation: SandboxOperation;

	/**
	The selected provider, if discovery or selection progressed far enough.
	*/
	readonly providerId?: string;

	/**
	The allocated backend, when its identity is known.
	*/
	readonly backendId?: string;

	/**
	Non-secret instructions for resources that may require manual cleanup.
	*/
	readonly recovery?: RecoveryDescriptor;
}

type OrdinarySandboxErrorName = Static<typeof ordinaryErrorNameSchema>;

/**
Structural shapes of the concrete sandbox errors, identified by stable class name.
Use `isSandboxError(value, ErrorClass)` to narrow errors across package copies.
Diagnostic causes must not be printed or serialised automatically.
*/
export type SandboxErrorInfo = Error &
	SandboxErrorContext & {
		/**
		Human-readable display text. Consumers must not parse it for classification.
		*/
		readonly message: string;
		/**
		Original diagnostic value, excluded from routine serialisation.
		*/
		readonly cause?: unknown;
	} & (
		| {
				[Name in OrdinarySandboxErrorName]: { readonly name: Name };
		  }[OrdinarySandboxErrorName]
		| {
				[
					Name in 'SandboxTransportError' | 'UnconfirmedSandboxTerminationError'
				]: {
					readonly name: Name;
					readonly reason?: CancellationReason;
					readonly completion: 'unknown';
				};
		  }['SandboxTransportError' | 'UnconfirmedSandboxTerminationError']
		| {
				readonly name: 'SandboxCleanupError';
				readonly closeReport?: SandboxCloseReport;
		  }
		| {
				readonly name: 'SandboxCancelledError';
				readonly reason: 'caller' | 'shutdown';
				readonly completion: OperationCompletion;
		  }
		| {
				readonly name: 'SandboxTimeoutError';
				readonly reason: 'deadline';
				readonly completion: OperationCompletion;
		  }
		| {
				readonly name: 'SandboxOutputCallbackError';
				readonly reason: 'output';
				readonly completion: OperationCompletion;
		  }
	);

/**
Stable class names recognised by the version 1 error protocol.
*/
export type SandboxErrorName = SandboxErrorInfo['name'];

/**
Result of bounded, idempotent shutdown for one generation. An incomplete
report includes recovery descriptors for resources requiring manual
attention.
*/
export interface SandboxCloseReport {
	/**
	True only when broker operations have finished under their declared
	termination scopes and allocation cleanup is confirmed. This does not
	guarantee that processes outside those scopes have stopped.
	*/
	readonly confirmed: boolean;

	/**
	Non-secret descriptors for allocations that may still need manual
	cleanup.
	*/
	readonly recoveries: readonly RecoveryDescriptor[];

	/**
	Typed shutdown errors whose causes must not be serialised automatically.
	*/
	readonly failures: readonly SandboxErrorInfo[];
}

/**
Consumer and provider entry points supplied by the SDK. The interface
permits injected clients in extensions and tests without changing provider
selection.
*/
export interface SandboxClient {
	readonly get: (
		context: SandboxContext,
		options?: SandboxAcquireOptions
	) => Promise<Sandbox>;
	readonly negotiate: (
		context: SandboxContext,
		options?: SandboxAcquireOptions
	) => Promise<SandboxNegotiation>;
}

export interface ShellReviewClient {
	readonly hasShellReviewRoute: () => boolean;
	readonly findShellReviewSource: (
		context: SandboxContext,
		call: ReviewedToolCall
	) => ShellReviewLookup;
}
