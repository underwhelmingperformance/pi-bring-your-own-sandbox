import { builtinProviders } from './builtin-providers.js';
import { resolveCleanupBudgets } from './cleanup-budgets.js';
import type { SandboxConfig } from './config.js';
import { resolveSandboxConfig } from './config.js';
import type {
	SandboxConfigContext,
	SandboxContext,
	SandboxHostOptions
} from './contracts.js';
import {
	ConflictingSandboxProviderError,
	InvalidSandboxConfigError,
	isSandboxError
} from './errors.js';
import { observe, OperationScope } from './lifecycle.js';
import { resolveHostUserDataRoots } from './path-grants.js';
import type { DiagnosticStore } from './provider-diagnostics.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import { invalidField, providerConfigSchema } from './request-schemas.js';
import type { RuntimeProvider } from './runtime-participant.js';
import { checker } from './schemas.js';

export interface RuntimeSettings {
	readonly diagnostics: DiagnosticStore;
	readonly lifetime: AbortSignal;
	readonly close: () => void;
	readonly read: (context: SandboxContext) => Promise<SandboxConfig>;
}

const isProviderConfig = checker(providerConfigSchema);

export function createRuntimeSettings(
	listProviders: () => readonly RuntimeProvider[],
	options: SandboxHostOptions | undefined
): RuntimeSettings {
	const defaults = resolveCleanupBudgets(options?.cleanup);
	const records = new ProviderDiagnostics();
	const diagnostics: DiagnosticStore = Object.freeze({
		record: records.record.bind(records),
		snapshot: records.snapshot.bind(records)
	});
	const lifetime = new AbortController();
	let config: Promise<SandboxConfig> | undefined;

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
					const profiles = [
						...provider.profiles.open,
						...provider.profiles.copy
					];
					const readRoots = provided.settings?.readRoots;
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

					return Object.freeze({
						...value,
						...(hostUserDataRoots !== undefined && { hostUserDataRoots }),
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
