import { Type } from 'typebox';

import type { ApprovalSelection } from './approval-contracts.js';
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
import { discoverProviders } from './discovery.js';
import {
	ConflictingSandboxConfigError,
	ConflictingSandboxProviderError,
	InvalidSandboxConfigError,
	InvalidSandboxRequestError,
	isSandboxError,
	ProviderNotFoundError
} from './errors.js';
import {
	discoverServices,
	ensureExtensionService,
	publishService
} from './extension-services.js';
import { observe, OperationScope } from './lifecycle.js';
import type { DiagnosticStore } from './provider-diagnostics.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import {
	approvalSelectionSchema,
	outsideSelectionSchema,
	providerConfigSchema
} from './request-schemas.js';
import { callable, checker, nonEmptyStringSchema } from './schemas.js';
import { runtimeSettingsSchema } from './service-schemas.js';

export interface RuntimeSettingsV1 {
	readonly configurationVersion: 1;
	readonly diagnostics: DiagnosticStore;
	readonly id: string;
	readonly lifetime: AbortSignal;
	readonly close: () => void;
	readonly assertConfigurable: () => void;
	readonly read: (context: SandboxContext) => Promise<SandboxConfig>;
	readonly normalExecutor?: SandboxHostOptions['normalExecutor'];
}
interface ConfigBinding {
	readonly id: string;
	readonly resolve: SandboxConfigResolver<unknown>;
}

const isRuntimeSettings = checker(runtimeSettingsSchema);
const isBinding = checker(
	Type.Object({
		id: nonEmptyStringSchema,
		resolve: callable<ConfigBinding['resolve']>()
	})
);
const isProviderConfig = checker(providerConfigSchema);
const isApprovalSelection = checker(approvalSelectionSchema);
const isOutsideSelection = checker(outsideSelectionSchema);
const channel = (domain: string) => `pi-byos:configuration:v1:${domain}`;

function bindings(pi: SandboxHost, domain: string): readonly ConfigBinding[] {
	return discoverServices(
		pi.events,
		channel(domain),
		isBinding,
		() => new ConflictingSandboxConfigError({ operation: 'configure' })
	);
}

function registerBinding(
	pi: SandboxHost,
	domain: string,
	binding: ConfigBinding
): void {
	runtimeSettings(pi).assertConfigurable();

	if (!isBinding(binding)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	publishService(pi.events, channel(domain), Object.freeze(binding));
}

export function registerProviderConfig(
	pi: SandboxHost,
	id: string,
	resolve: SandboxConfigResolver<SandboxProviderConfig<unknown>>
): void {
	registerBinding(pi, 'providers', { id, resolve });
}

/**
Selects the execution approval policy from extension-owned configuration.
Register during extension loading; the resolver runs once per generation.
*/
export function configureExecutionApproval(
	pi: SandboxHost,
	resolve: SandboxConfigResolver<ApprovalSelection>
): void {
	registerBinding(pi, 'approval', { id: 'approval', resolve });
}

/**
Selects the destination for explicitly approved outside execution. This binding
is independent of provider activation and does not allocate either destination.
*/
export function configureOutsideExecution(
	pi: SandboxHost,
	resolve: SandboxConfigResolver<{
		readonly destination: 'normal' | 'provider';
	}>
): void {
	registerBinding(pi, 'outside', { id: 'outside', resolve });
}

export function runtimeSettings(
	pi: SandboxHost,
	options?: SandboxHostOptions
): RuntimeSettingsV1 {
	return ensureExtensionService(
		pi.events,
		'pi-byos:settings:v1',
		isRuntimeSettings,
		(id) => {
			const defaults = resolveCleanupBudgets(options?.cleanup);
			const records = new ProviderDiagnostics();
			const diagnostics: DiagnosticStore = Object.freeze({
				record: records.record.bind(records),
				snapshot: records.snapshot.bind(records)
			});
			const lifetime = new AbortController();
			let config: Promise<SandboxConfig> | undefined;
			let isSealed = false;

			async function configured(
				context: SandboxContext
			): Promise<SandboxConfig> {
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

					const approvalBindings = bindings(pi, 'approval');
					const outsideBindings = bindings(pi, 'outside');
					const resolutionContext: SandboxConfigContext = Object.freeze({
						...scope.context,
						pi: context
					});
					const pending = observe(
						Promise.try(async () => {
							const [provided, approval, outside] = await Promise.all([
								activation === undefined
									? { configuration: {} }
									: activation.resolve(resolutionContext),
								approvalBindings[0]?.resolve(resolutionContext),
								outsideBindings[0]?.resolve(resolutionContext)
							]);

							scope.check();

							if (
								!isProviderConfig(provided) ||
								(approval !== undefined && !isApprovalSelection(approval)) ||
								(outside !== undefined && !isOutsideSelection(outside))
							) {
								throw new InvalidSandboxConfigError({
									operation: 'configure',
									providerId: provider.id,
									configurationSource: 'extension'
								});
							}

							const value = resolveSandboxConfig(
								provider,
								provided,
								activation === undefined ? 'default' : 'extension'
							);

							return Object.freeze({
								...value,
								...(approval !== undefined && {
									approval: Object.freeze({
										policy: approval.policy,
										...(approval.config !== undefined && {
											config: approval.config
										})
									})
								}),
								...(outside !== undefined && {
									outsideSandbox: Object.freeze({ ...outside })
								}),
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

			return {
				configurationVersion: 1,
				diagnostics,
				id,
				lifetime: lifetime.signal,
				close: () => {
					lifetime.abort();
				},
				...(options?.normalExecutor !== undefined && {
					normalExecutor: options.normalExecutor
				}),
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
		}
	);
}

export function bindRuntimeSettings(
	pi: SandboxHost,
	options: SandboxHostOptions
): void {
	const state = { exists: false };

	pi.events.emit('pi-byos:settings:v1', {
		kind: 'pi-byos.discover',
		discoveryVersion: 1,
		reply() {
			state.exists = true;
		}
	});

	if (state.exists) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	runtimeSettings(pi, options);
}
