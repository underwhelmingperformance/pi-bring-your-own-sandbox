import type {
	SandboxConfigResolver,
	SandboxContext,
	SandboxHost,
	SandboxHostOptions,
	SandboxProviderConfig
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import type { ProviderInfo, ProviderServiceV1 } from './protocol.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import type { BrokerPin } from './protocol-payloads.js';

export interface RuntimeProvider extends ProviderServiceV1 {
	readonly resolve: SandboxConfigResolver<SandboxProviderConfig<unknown>>;
}

export interface ShellSettings {
	readonly lifetime: AbortSignal;
	readonly read: (context: SandboxContext) => Promise<{
		readonly allowsEscalation: boolean;
		readonly providerId: string;
	}>;
}

export interface RuntimeParticipant {
	readonly providers: readonly RuntimeProvider[];
	readonly hostOptions?: SandboxHostOptions;
	readonly commit: (settings: ShellSettings) => void;
}

interface RuntimeBindings {
	readonly providers: RuntimeProvider[];
	hostOptions?: SandboxHostOptions;
	wantsShellSettings?: true;
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

	const local: RuntimeBindings = { providers: [] };

	bindings.set(pi, local);

	return local;
}

export function registerHostOptions(
	pi: SandboxHost,
	options: SandboxHostOptions
): void {
	const local = localRuntimeBindings(pi);

	if (local.hostOptions !== undefined || local.pin !== undefined) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	local.hostOptions = Object.freeze({
		...(options.cleanup !== undefined && {
			cleanup: Object.freeze({ ...options.cleanup })
		})
	});
}

export function registerShellSettings(pi: SandboxHost): void {
	localRuntimeBindings(pi).wantsShellSettings = true;
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
