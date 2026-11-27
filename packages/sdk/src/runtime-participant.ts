import type { SandboxBroker } from './broker.js';
import type {
	SandboxConfigContext,
	SandboxContext,
	SandboxHost,
	SandboxHostHandle,
	SandboxHostOptions
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import type { ConfiguredProviderV1, ProviderInfo } from './protocol.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import type { BrokerPin } from './protocol-payloads.js';
import type { ShellRouteRegistration } from './shell-review-routes.js';

export interface RuntimeProvider extends ProviderInfo {
	readonly protocol: ProtocolIdentity;
	readonly configure?: (
		context: SandboxConfigContext
	) => Promise<ConfiguredProviderV1>;
}

export interface ShellSettings {
	readonly lifetime: AbortSignal;
	readonly read: (context: SandboxContext) => Promise<{
		readonly allowEscalation: boolean;
		readonly isUnrestrictedHost: boolean;
		readonly hostUserDataRoots?: readonly string[];
	}>;
}

interface HostRegistration {
	readonly options: SandboxHostOptions;
	readonly receive: (close: SandboxHostHandle['close']) => void;
}

export interface RuntimeParticipant {
	readonly providers: readonly RuntimeProvider[];
	readonly host?: HostRegistration;
	readonly shellRoutes: readonly ShellRouteRegistration[];
	readonly commit: () => void;
}

interface RuntimeBindings {
	readonly providers: RuntimeProvider[];
	readonly shellRoutes: ShellRouteRegistration[];
	owner?: SandboxBroker;
	host?: HostRegistration;
	shellSettings?: ShellSettings;
	pin?: BrokerPin;
}

const bindings = new WeakMap<SandboxHost, RuntimeBindings>();

export function areProtocolIdentitiesEqual(
	a: ProtocolIdentity,
	b: ProtocolIdentity
): boolean {
	return (
		a.extensionSource === b.extensionSource &&
		a.buildId === b.buildId &&
		a.packageVersion === b.packageVersion &&
		a.major === b.major &&
		a.featureLevel === b.featureLevel
	);
}

export function localRuntimeBindings(pi: SandboxHost): RuntimeBindings {
	const existing = bindings.get(pi);

	if (existing !== undefined) {
		return existing;
	}

	const local: RuntimeBindings = { providers: [], shellRoutes: [] };

	bindings.set(pi, local);

	return local;
}

export function registerHostOptions(
	pi: SandboxHost,
	options: SandboxHostOptions,
	receive: HostRegistration['receive']
): void {
	const local = localRuntimeBindings(pi);

	if (local.host !== undefined || local.pin !== undefined) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	local.host = Object.freeze({
		receive,
		options: Object.freeze({
			...(options.agentDirectory !== undefined && {
				agentDirectory: options.agentDirectory
			}),
			...(options.cleanup !== undefined && {
				cleanup: Object.freeze({ ...options.cleanup })
			})
		})
	});
}

export function shellSettings(pi: SandboxHost): ShellSettings {
	const settings = localRuntimeBindings(pi).shellSettings;

	if (settings === undefined) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	return settings;
}

export type DiscoveredProvider = ProviderInfo & {
	readonly protocol: ProtocolIdentity;
};
