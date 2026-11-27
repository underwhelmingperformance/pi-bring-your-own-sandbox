import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { builtinProviders } from './builtin-providers.js';
import { resolveCleanupBudgets } from './cleanup-budgets.js';
import type { SandboxConfig } from './config.js';
import { resolveSandboxConfig } from './config.js';
import type {
	SandboxConfigContext,
	SandboxContext,
	SandboxHostOptions
} from './contracts.js';
import { resolveCredentialExclusions } from './credential-locations.js';
import {
	ConflictingSandboxProviderError,
	InvalidSandboxConfigError,
	isSandboxError,
	SandboxProviderUnavailableError
} from './errors.js';
import { observe, OperationScope } from './lifecycle.js';
import { resolveHostUserDataRoots } from './path-grants.js';
import type { DiagnosticStore } from './provider-diagnostics.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import { bindReadRootPersistence } from './read-root-persistence.js';
import { invalidField } from './request-schemas.js';
import type { RuntimeProvider } from './runtime-participant.js';
import { checker } from './schemas.js';
import { configuredProviderSchema } from './service-schemas.js';

export interface RuntimeSettings {
	readonly diagnostics: DiagnosticStore;
	readonly lifetime: AbortSignal;
	readonly close: () => void;
	readonly read: (context: SandboxContext) => Promise<SandboxConfig>;
}

const isConfiguredProvider = checker(configuredProviderSchema);

export function createRuntimeSettings(
	listProviders: () => readonly RuntimeProvider[],
	options: SandboxHostOptions | undefined
): RuntimeSettings {
	const agentDirectory = path.resolve(options?.agentDirectory ?? getAgentDir());
	const defaults = resolveCleanupBudgets(options?.cleanup);
	const records = new ProviderDiagnostics();
	const diagnostics: DiagnosticStore = Object.freeze({
		record: records.record.bind(records),
		snapshot: records.snapshot.bind(records)
	});
	const lifetime = new AbortController();
	let config: Promise<SandboxConfig> | undefined;
	let exclusions: Promise<readonly string[]> | undefined;

	async function configured(context: SandboxContext): Promise<SandboxConfig> {
		const scope = new OperationScope(
			{ operation: 'configure' },
			lifetime.signal,
			{},
			60_000
		);
		let selectedId: string | undefined;

		try {
			const providers = listProviders();

			if (providers.length > 1) {
				throw new ConflictingSandboxProviderError({
					operation: 'configure'
				});
			}

			const activation = providers[0];
			const provider = activation ?? builtinProviders.defaultProvider;

			selectedId = provider.id;
			scope.setDiagnosticReporter((identity, diagnostic) => {
				diagnostics.record(
					{ ...identity, providerId: provider.id },
					diagnostic
				);
			});

			const resolutionContext: SandboxConfigContext = Object.freeze({
				...scope.context,
				pi: context,
				agentDirectory
			});
			const pending = observe(
				Promise.try(async () => {
					const extensionSource = provider.protocol?.extensionSource;
					const identity = {
						operation: 'configure' as const,
						providerId: provider.id,
						...(extensionSource !== undefined && { extensionSource })
					};

					if (provider.unavailable !== undefined) {
						throw new SandboxProviderUnavailableError({
							...identity,
							detail: {
								kind: 'provider-unavailable',
								reason: provider.unavailable
							}
						});
					}

					const provided = await activation?.configure?.(resolutionContext);

					scope.check();

					if (activation !== undefined && !isConfiguredProvider(provided)) {
						const field =
							invalidField(configuredProviderSchema, provided).join('.') ||
							'settings';

						throw new InvalidSandboxConfigError({
							...identity,
							detail: { kind: 'config', field }
						});
					}

					const value = resolveSandboxConfig(
						provider,
						provided?.settings,
						activation === undefined ? 'default' : 'extension'
					);
					const profiles = [
						...provider.profiles.open,
						...provider.profiles.copy
					];
					const readRoots = provided?.settings?.readRoots;
					let hostUserDataRoots: readonly string[] | undefined;

					if (
						readRoots !== undefined ||
						(activation !== undefined &&
							profiles.some(({ policy }) => policy.hostUserData !== 'denied'))
					) {
						try {
							hostUserDataRoots = await resolveHostUserDataRoots(readRoots);
						} catch (error) {
							throw new InvalidSandboxConfigError(
								{
									...identity,
									detail: { kind: 'config', field: 'settings.readRoots' }
								},
								{ cause: error }
							);
						}
					}

					scope.check();

					const saveReadRoots =
						provided?.persistReadRoot !== undefined &&
						value.selection.policy.hostUserData === 'read-only'
							? bindReadRootPersistence(
									provider,
									provided.persistReadRoot,
									agentDirectory
								)
							: undefined;

					return Object.freeze({
						...value,
						resolveCredentialExclusions: () =>
							(exclusions ??= resolveCredentialExclusions(agentDirectory)),
						...(provided !== undefined && { configured: provided }),
						...(hostUserDataRoots !== undefined && { hostUserDataRoots }),
						...(saveReadRoots !== undefined && { saveReadRoots }),
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
					...(selectedId !== undefined && { providerId: selectedId })
				},
				{ cause: error }
			);
		} finally {
			scope.dispose();
		}
	}

	return Object.freeze<RuntimeSettings>({
		diagnostics,
		lifetime: lifetime.signal,
		close: () => {
			lifetime.abort();
		},
		read(context) {
			config ??= configured(context);

			return config;
		}
	});
}
