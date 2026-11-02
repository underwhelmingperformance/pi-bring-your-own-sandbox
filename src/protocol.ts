import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxBackend,
	SandboxCapabilities,
	SandboxCloseReport,
	SandboxContext,
	SandboxDiagnosticRecord,
	SandboxErrorInfo,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxPolicy,
	SandboxWorkspace,
	ShellDialect,
	SupportedSandboxPolicies
} from './contracts.js';
import type { OutsideProviderServiceV1 } from './outside-execution.js';

/**
Synchronous Pi event-bus channel for discovering the runtime broker,
including its closed tombstone.
*/
export const BROKER_DISCOVERY_CHANNEL = 'pi-byos:discovery:v1:brokers';
/**
Synchronous Pi event-bus channel for collecting provider declarations after
extension factories complete.
*/
export const PROVIDER_DISCOVERY_CHANNEL = 'pi-byos:discovery:v1:providers';

/**
Versioned discovery envelope. Responders must reply synchronously during
event delivery.
*/
export interface DiscoveryRequestV1 {
	/**
	Fixed discriminator for discovery requests.
	*/
	readonly kind: 'pi-byos.discover';

	/**
	Discovery envelope version, independent of service versions.
	*/
	readonly discoveryVersion: 1;

	/**
	Accept untrusted advertisements synchronously; replies after emission
	returns are ignored.
	*/
	readonly reply: (advertisement: unknown) => void;
}

/**
Untrusted discovery reply. Validate the envelope, supported versions and
service before use.
*/
export interface ServiceAdvertisementV1 {
	/**
	Distinguishes broker and provider responders on their respective
	channels.
	*/
	readonly kind: 'pi-byos.broker' | 'pi-byos.provider';

	/**
	Discovery envelope version understood before inspecting the service.
	*/
	readonly discoveryVersion: 1;

	/**
	Non-empty list of supported positive integer service versions.
	*/
	readonly serviceVersions: readonly number[];

	/**
	Non-empty broker or provider identity, required to match the service
	identity.
	*/
	readonly id: string;

	/**
	Untrusted service object validated before any method invocation.
	*/
	readonly service: unknown;
}

/**
Provider configuration captured in a closure after synchronous validation.
Opening preserves the provider configuration type.
*/
export interface ConfiguredProviderV1 {
	/**
	Open using the captured typed configuration and supplied generation
	request. Report recovery metadata before allocation.
	*/
	readonly open: (
		request: Omit<SandboxOpenRequest, 'configuration'>,
		context: SandboxOpenContext
	) => Promise<SandboxBackend>;
}

/**
Version 1 provider responder shared across separately installed SDK copies.
Discovery and configuration allocate no backend.
*/
export interface ProviderServiceV1 {
	/**
	Optional provider-defined execution destination, independent of approval selection.
	*/
	readonly outsideSandbox?: OutsideProviderServiceV1;
	/**
	Discovery identity; duplicate IDs prevent selection.
	*/
	readonly id: string;

	/**
	Operator-facing provider label.
	*/
	readonly label: string;

	/**
	Declared maximum operations and shell dialects.
	*/
	readonly capabilities: SandboxCapabilities;

	/**
	Protection values accepted during selection.
	*/
	readonly policies: SupportedSandboxPolicies;

	/**
	Synchronously validate unknown input and capture it in an opening
	closure without allocation.
	*/
	readonly configure: (input: unknown) => ConfiguredProviderV1;
}

/**
Generation lifecycle reported without allocating a backend. Failed and
closed states remain discoverable.
*/
export type BrokerState =
	| 'initialising'
	| 'idle'
	| 'opening'
	| 'ready'
	| 'failed'
	| 'closing'
	| 'closed';

/**
Personal selection with its source and complete protection policy.
*/
export interface ProviderSelection {
	/**
	Provider chosen by personal configuration, defaulting to `passthrough`.
	*/
	readonly providerId: string;

	/**
	Whether selection used the implicit default or personal settings.
	*/
	readonly source: 'default' | 'personal';

	/**
	Complete requirements applied before backend publication.
	*/
	readonly policy: SandboxPolicy;

	/**
	Explicit dialect for optional routing of user shell commands.
	*/
	readonly userShell?: ShellDialect;
}

/**
Readonly generation snapshot. Status inspection must never open a backend.
*/
export interface SandboxStatus {
	/**
	Bounded provider warnings, in reporting order. Omitted when empty.
	*/
	readonly diagnostics?: readonly SandboxDiagnosticRecord[];
	/**
	Invalid, oversized or excess diagnostics discarded by the broker.
	*/
	readonly diagnosticsDropped?: number;
	/**
	Generation whose state and metadata this snapshot reports.
	*/
	readonly generationId: string;

	/**
	Current lifecycle state, including persistent failure or closure.
	*/
	readonly state: BrokerState;

	/**
	Available after configuration resolves, even when opening fails.
	*/
	readonly selection?: ProviderSelection;

	/**
	Available after allocation establishes an identity.
	*/
	readonly backendId?: string;

	/**
	Target metadata after successful backend validation.
	*/
	readonly workspace?: SandboxWorkspace;

	/**
	Effective operation groups after successful backend validation.
	*/
	readonly capabilities?: SandboxCapabilities;

	/**
	Effective protections after backend validation. Before startup, only the
	requested policy in `selection` is available.
	*/
	readonly policy?: SandboxPolicy;

	/**
	Provider explanation of the effective boundary.
	*/
	readonly policyDescription?: string;

	/**
	Persistent typed acquisition or operation failure, when the generation
	is unhealthy.
	*/
	readonly failure?: SandboxErrorInfo;

	/**
	Completed bounded shutdown report, when available.
	*/
	readonly closeReport?: SandboxCloseReport;
}

/**
Provider metadata safe to enumerate without provisioning resources or
exposing configuration.
*/
export interface ProviderInfo {
	/**
	Discovery identity without provider configuration.
	*/
	readonly id: string;

	/**
	Operator-facing label for enumeration.
	*/
	readonly label: string;

	/**
	Declared maximum operations without allocating a backend.
	*/
	readonly capabilities: SandboxCapabilities;

	/**
	Supported protection choices without allocating a backend.
	*/
	readonly policies: SupportedSandboxPolicies;
}

/**
Version 1 broker service discovered through Pi. A runtime has one service;
session generations allocate their own backend lazily.
*/
export interface BrokerServiceV1 {
	/**
	Runtime service identity shared across independently installed SDK
	copies.
	*/
	readonly id: string;

	/**
	Acquire the generation backend and validate requirements. Concurrent
	callers share startup with independent waiter cancellation.
	*/
	readonly acquire: (
		context: SandboxContext,
		options?: SandboxAcquireOptions
	) => Promise<Sandbox>;

	/**
	Begin the shutdown barrier and return the generation cleanup report.
	Repeated calls share the result.
	*/
	readonly close: (context: SandboxContext) => Promise<SandboxCloseReport>;

	/**
	Inspect generation metadata without provisioning a backend.
	*/
	readonly status: (context: SandboxContext) => Promise<SandboxStatus>;

	/**
	Validate configuration and enumerate providers without provisioning
	resources. Backend startup or operation failures do not prevent
	enumeration of the validated declarations.
	*/
	readonly providers: (
		context: SandboxContext
	) => Promise<readonly ProviderInfo[]>;
}
