import { randomUUID } from 'node:crypto';

import { builtinProviders } from './builtin-providers.js';
import { resolveCleanupBudgets } from './cleanup-budgets.js';
import type { SandboxConfig } from './config.js';
import { resolveSandboxConfig } from './config.js';
import type {
	SandboxConfigContext,
	SandboxConfigResolver,
	SandboxContext,
	SandboxHost,
	SandboxHostOptions,
	SandboxProviderConfig
} from './contracts.js';
import { bindFactory, ensureSandboxService } from './default-broker.js';
import { discoverProviders } from './discovery.js';
import {
	ConflictingSandboxConfigError,
	ConflictingSandboxProviderError,
	InvalidSandboxConfigError,
	InvalidSandboxRequestError,
	isSandboxError,
	ProviderNotFoundError,
	SandboxInitialisationError
} from './errors.js';
import { observe, OperationScope } from './lifecycle.js';
import { bindProtocolAddress, isPiBound } from './protocol-address.js';
import { configBindingSchema, hostBindingSchema } from './protocol-payloads.js';
import type { DiagnosticStore } from './provider-diagnostics.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import { invalidField, providerConfigSchema } from './request-schemas.js';
import {
	discoverRuntimeServices,
	publishRuntimeService
} from './runtime-services.js';
import { checker } from './schemas.js';
import { runtimeSettingsSchema } from './service-schemas.js';

export interface RuntimeSettingsV1 {
	readonly diagnostics: DiagnosticStore;
	readonly id: string;
	readonly lifetime: AbortSignal;
	readonly close: () => void;
	readonly assertConfigurable: () => void;
	readonly read: (context: SandboxContext) => Promise<SandboxConfig>;
}
interface ConfigBinding {
	readonly id: string;
	readonly resolve: SandboxConfigResolver<unknown>;
}

const isRuntimeSettings = checker(runtimeSettingsSchema);
const isBinding = checker(configBindingSchema);
const isProviderConfig = checker(providerConfigSchema);
const channel = (domain: string) => `configuration-${domain}`;

function bindings(pi: SandboxHost, domain: string): readonly ConfigBinding[] {
	return discoverRuntimeServices(
		pi.events,
		channel(domain),
		configBindingSchema,
		isBinding,
		() => new ConflictingSandboxConfigError({ operation: 'configure' })
	);
}

function registerBinding(
	pi: SandboxHost,
	domain: string,
	binding: ConfigBinding
): void {
	if (!isBinding(binding)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	publishRuntimeService(
		pi.events,
		channel(domain),
		configBindingSchema,
		Object.freeze(binding)
	);
}

export function registerProviderConfig(
	pi: SandboxHost,
	id: string,
	resolve: SandboxConfigResolver<SandboxProviderConfig<unknown>>
): void {
	registerBinding(pi, 'providers', { id, resolve });
}

const isHostBinding = checker(hostBindingSchema);

function configuredHostOptions(
	pi: SandboxHost
): SandboxHostOptions | undefined {
	const hosts = discoverRuntimeServices(
		pi.events,
		'host-options',
		hostBindingSchema,
		isHostBinding
	);

	if (hosts.length > 1) {
		throw new ConflictingSandboxConfigError({ operation: 'configure' });
	}

	return hosts[0]?.options;
}

export function createRuntimeSettings(pi: SandboxHost): RuntimeSettingsV1 {
	const id = randomUUID();
	const options = configuredHostOptions(pi);
	const defaults = resolveCleanupBudgets(options?.cleanup);
	const records = new ProviderDiagnostics();
	const diagnostics: DiagnosticStore = Object.freeze({
		record: records.record.bind(records),
		snapshot: records.snapshot.bind(records)
	});
	const lifetime = new AbortController();
	let config: Promise<SandboxConfig> | undefined;
	let isSealed = false;

	async function configured(context: SandboxContext): Promise<SandboxConfig> {
		isSealed = true;

		const scope = new OperationScope(
			{ operation: 'configure' },
			lifetime.signal,
			{},
			60_000
		);
		let selectedId: string | undefined;

		try {
			const providers = discoverProviders(pi.events);
			const activations = bindings(pi, 'providers');

			if (activations.length > 1) {
				throw new ConflictingSandboxProviderError({
					operation: 'configure'
				});
			}

			const activation = activations[0];
			const provider =
				activation === undefined
					? builtinProviders.defaultProvider
					: providers.find((entry) => entry.id === activation.id);

			if (provider === undefined) {
				throw new ProviderNotFoundError({
					operation: 'configure',
					...(activation !== undefined && { providerId: activation.id })
				});
			}

			selectedId = provider.id;
			scope.setDiagnosticReporter((identity, diagnostic) => {
				diagnostics.record(
					{ ...identity, providerId: provider.id },
					diagnostic
				);
			});

			const resolutionContext: SandboxConfigContext = Object.freeze({
				...scope.context,
				pi: context
			});
			const pending = observe(
				Promise.try(async () => {
					const provided =
						activation === undefined
							? { configuration: {} }
							: await activation.resolve(resolutionContext);

					scope.check();

					const extensionSource = provider.protocol?.extensionSource;
					const identity = {
						operation: 'configure' as const,
						providerId: provider.id,
						configurationSource: 'extension' as const,
						...(extensionSource !== undefined && { extensionSource })
					};

					if (!isProviderConfig(provided)) {
						const field =
							invalidField(providerConfigSchema, provided).join('.') ||
							'settings';

						throw new InvalidSandboxConfigError({
							...identity,
							detail: { kind: 'config', field }
						});
					}

					const value = resolveSandboxConfig(
						provider,
						provided,
						activation === undefined ? 'default' : 'extension'
					);

					return Object.freeze({
						...value,
						cleanup: resolveCleanupBudgets({
							...defaults,
							...value.cleanup
						})
					});
				})
			);
			const result = await Promise.race([pending, scope.whenCancelled()]);

			scope.check();

			if (result.kind === 'cancelled') {
				throw scope.cancellationError('not-started');
			}

			if (result.kind === 'rejected') {
				throw result.error;
			}

			return result.value;
		} catch (error) {
			if (isSandboxError(error)) {
				throw error;
			}

			throw new InvalidSandboxConfigError(
				{
					operation: 'configure',
					configurationSource: 'extension',
					...(selectedId !== undefined && { providerId: selectedId })
				},
				{ cause: error }
			);
		} finally {
			scope.dispose();
		}
	}

	pi.on('session_shutdown', () => {
		lifetime.abort();
	});

	const service: RuntimeSettingsV1 = {
		diagnostics,
		id,
		lifetime: lifetime.signal,
		close: () => {
			lifetime.abort();
		},
		assertConfigurable() {
			if (isSealed || lifetime.signal.aborted) {
				throw new InvalidSandboxRequestError({ operation: 'configure' });
			}
		},
		read(context) {
			config ??= configured(context);

			return config;
		}
	};

	publishRuntimeService(
		pi.events,
		'settings',
		runtimeSettingsSchema,
		Object.freeze(service)
	);

	return service;
}

function discoverSettings(pi: SandboxHost): RuntimeSettingsV1 | undefined {
	const discovered = discoverRuntimeServices(
		pi.events,
		'settings',
		runtimeSettingsSchema,
		isRuntimeSettings
	);

	if (discovered.length > 1) {
		throw new ConflictingSandboxConfigError({ operation: 'configure' });
	}

	return discovered[0];
}

export function runtimeSettings(pi: SandboxHost): RuntimeSettingsV1 {
	const existing = discoverSettings(pi);

	if (existing !== undefined) {
		return existing;
	}

	ensureSandboxService(pi);

	const selected = discoverSettings(pi);

	if (selected === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	return selected;
}

export function bindRuntimeSettings(
	pi: SandboxHost,
	extensionSource: string,
	options: SandboxHostOptions
): void {
	if (isPiBound(pi)) {
		bindProtocolAddress(pi.events, extensionSource);
	} else {
		bindFactory(pi, extensionSource);
	}

	if (discoverSettings(pi) !== undefined) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	if (configuredHostOptions(pi) !== undefined) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	const host = { id: randomUUID(), options };

	publishRuntimeService(pi.events, 'host-options', hostBindingSchema, host);
}
