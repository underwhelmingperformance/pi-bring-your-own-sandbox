import { randomUUID } from 'node:crypto';

import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import { acquireOptions } from './acquire-options.js';
import type {
	OutsideSandboxExecutor,
	OutsideSandboxProvider
} from './approval-contracts.js';
import {
	ApprovalDeniedError,
	InvalidApprovalRequestError
} from './approval-errors.js';
import { outsideProcessOptionsSchema } from './approval-schemas.js';
import { SandboxBroker } from './broker.js';
import { reportCleanup } from './cleanup-report.js';
import type { SandboxConfig } from './config.js';
import { inspectContext } from './context.js';
import type {
	ProcessRequest,
	Sandbox,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxErrorInfo,
	SandboxHost
} from './contracts.js';
import { discoverProviders } from './discovery.js';
import {
	InvalidSandboxDeclarationError,
	isSandboxError,
	ProviderNotFoundError,
	SandboxCancelledError,
	SandboxSessionClosingError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import {
	boundedApproval,
	requestExecutionApproval
} from './execution-approval.js';
import {
	discoverServices,
	ensureExtensionService
} from './extension-services.js';
import { OperationRegistry, OperationScope } from './lifecycle.js';
import { passthroughProvider } from './passthrough-provider.js';
import {
	snapshotProcessOptions,
	snapshotProcessRequest
} from './process-input.js';
import type {
	BrokerServiceV1,
	ProviderServiceV1,
	SandboxStatus
} from './protocol.js';
import { runtimeSettings } from './runtime-settings.js';
import { checker } from './schemas.js';
import {
	outsideProviderSchema,
	outsideServiceSchema
} from './service-schemas.js';
import { snapshotCapabilities } from './validation.js';

/**
Optional provider service extension for execution outside its ordinary sandbox.
*/
export interface OutsideProviderServiceV1 {
	/**
	Description of the provider-defined destination for approval prompts.
	*/
	readonly label: string;
	/**
	Maximum operation and shell capabilities of the outside backend.
	*/
	readonly capabilities: OutsideSandboxProvider<unknown>['capabilities'];
	/**
	Required protections checked before an outside backend is published.
	*/
	readonly policy: OutsideSandboxProvider<unknown>['policy'];
	/**
	Validate provider settings and return the outside allocation closure.
	*/
	readonly configure: (
		input: unknown
	) => ReturnType<ProviderServiceV1['configure']>;
}

const isOutsideProvider = checker(outsideProviderSchema);
const isOutsideService = checker(outsideServiceSchema);
const isOutsideOptions = checker(outsideProcessOptionsSchema);

function outsideProvider(
	pi: SandboxHost,
	config: SandboxConfig
): ProviderServiceV1 {
	const provider = [passthroughProvider, ...discoverProviders(pi.events)].find(
		(provider) => provider.id === config.selection.providerId
	);

	if (provider === undefined) {
		throw new ProviderNotFoundError({
			operation: 'configure',
			providerId: config.selection.providerId
		});
	}

	if (!isOutsideProvider(provider.outsideSandbox)) {
		throw new UnsupportedSandboxCapabilityError({
			operation: 'configure',
			providerId: provider.id
		});
	}

	const outside = provider.outsideSandbox;

	return {
		id: provider.id,
		label: outside.label,
		capabilities: snapshotCapabilities(outside.capabilities),
		policies: {
			workspaceAccess: [outside.policy.workspaceAccess],
			filesystemScope: [outside.policy.filesystemScope],
			networkAccess: [outside.policy.networkAccess]
		},
		configure: outside.configure.bind(outside)
	};
}

function normalProvider(
	provider: OutsideSandboxProvider<undefined>
): ProviderServiceV1 {
	return {
		id: 'normal',
		label: provider.label,
		capabilities: snapshotCapabilities(provider.capabilities),
		policies: {
			workspaceAccess: [provider.policy.workspaceAccess],
			filesystemScope: [provider.policy.filesystemScope],
			networkAccess: [provider.policy.networkAccess]
		},
		configure: () => ({
			open: (request, context) =>
				provider.open({ ...request, configuration: undefined }, context)
		})
	};
}

export interface OutsideServiceV1 {
	readonly status: (
		context: SandboxContext
	) => Promise<SandboxStatus | undefined>;
	readonly close: (context: SandboxContext) => Promise<SandboxCloseReport>;
	readonly track: <Result>(
		scope: OperationScope,
		execute: () => Promise<Result>
	) => Promise<Result>;
	readonly assertLive: () => void;
	readonly lifetime: AbortSignal;
	readonly id: string;
	readonly acquire: (
		context: ExtensionContext,
		options?: SandboxAcquireOptions
	) => Promise<{
		readonly sandbox: Sandbox;
		readonly kind: 'normal' | 'provider';
		readonly label: string;
	}>;
}

function executionPolicy(provider: ProviderServiceV1) {
	const workspaceAccess = provider.policies.workspaceAccess[0];
	const filesystemScope = provider.policies.filesystemScope[0];
	const networkAccess = provider.policies.networkAccess[0];

	if (
		workspaceAccess === undefined ||
		filesystemScope === undefined ||
		networkAccess === undefined
	) {
		throw new InvalidSandboxDeclarationError({ operation: 'configure' });
	}

	return { workspaceAccess, filesystemScope, networkAccess };
}

function outsideService(pi: SandboxHost): OutsideServiceV1 {
	if (runtimeSettings(pi).lifetime.aborted) {
		throw new SandboxSessionClosingError({ operation: 'acquire' });
	}

	return ensureExtensionService(
		pi.events,
		'pi-byos:discovery:v1:outside-execution',
		isOutsideService,
		(id) => {
			const settings = runtimeSettings(pi);
			let broker: BrokerServiceV1 | undefined;
			const lifetime = new AbortController();
			const operations = new OperationRegistry();
			const failures: SandboxErrorInfo[] = [];
			let closing: Promise<SandboxCloseReport> | undefined;

			let selected: ProviderServiceV1 | undefined;
			let kind: 'normal' | 'provider' = 'normal';

			const assertLive = () => {
				if (failures[0] !== undefined) {
					throw failures[0];
				}

				if (lifetime.signal.aborted) {
					throw new SandboxSessionClosingError({ operation: 'acquire' });
				}
			};

			const close = (context: SandboxContext) => {
				lifetime.abort();
				closing ??= (async () => {
					await operations.drain();

					const report = (await broker?.close(context)) ?? {
						confirmed: true,
						failures: [],
						recoveries: []
					};

					return Object.freeze({
						confirmed: report.confirmed && failures.length === 0,
						failures: Object.freeze([...report.failures, ...failures]),
						recoveries: report.recoveries
					});
				})();

				return closing;
			};

			pi.on('session_shutdown', async (_event, context) => {
				reportCleanup(pi, context, await close(context));
			});

			return {
				id,
				async status(context) {
					return broker?.status(context);
				},
				lifetime: lifetime.signal,
				assertLive,
				async track(scope, execute) {
					assertLive();

					return operations.run(scope, async () => {
						try {
							return await execute();
						} catch (error) {
							if (
								isSandboxError(error) &&
								'completion' in error &&
								error.completion === 'unknown'
							) {
								failures.push(error);
							}

							throw error;
						}
					});
				},
				close,
				async acquire(context, options) {
					inspectContext(context, 'acquire');

					assertLive();

					const config = await settings.read();

					assertLive();

					if (broker === undefined) {
						kind = config.outsideSandbox?.destination ?? 'normal';
						selected =
							kind === 'provider'
								? outsideProvider(pi, config)
								: settings.normalExecutor === undefined
									? passthroughProvider
									: normalProvider(settings.normalExecutor);

						const provider = selected;

						broker = new SandboxBroker(
							randomUUID(),
							pi,
							{
								providers: () => [provider],
								readConfig: () =>
									Promise.resolve({
										selection: {
											providerId: provider.id,
											source: 'personal',
											policy: {
												workspaceAccess:
													executionPolicy(provider).workspaceAccess,
												filesystemScope:
													executionPolicy(provider).filesystemScope,
												networkAccess: executionPolicy(provider).networkAccess
											}
										},
										providerConfig:
											kind === 'provider' ? config.providerConfig : {},
										providerConfigSource: 'personal',
										...(config.cleanup !== undefined && {
											cleanup: config.cleanup
										})
									})
							},
							'owner'
						);
					}

					const sandbox = await broker.acquire(context, options);

					if (selected === undefined) {
						throw new InvalidSandboxDeclarationError({ operation: 'acquire' });
					}

					return { sandbox, kind, label: selected.label };
				}
			};
		}
	);
}

/**
Prepare the personally configured outside execution destination. This opens no
ordinary sandbox. Execution requires a fresh approval for every invocation.
*/
export async function getOutsideSandboxExecutor(
	pi: SandboxHost,
	context: ExtensionContext,
	options?: SandboxAcquireOptions
): Promise<OutsideSandboxExecutor> {
	inspectContext(context, 'acquire');

	const snapshot = acquireOptions(options);

	const service = outsideService(pi);
	const preparation = new OperationScope(
		{ operation: 'acquire' },
		service.lifetime,
		snapshot,
		60_000
	);
	let resolved: Awaited<ReturnType<OutsideServiceV1['acquire']>>;

	try {
		resolved = await boundedApproval(preparation, () =>
			service.acquire(context, {
				...snapshot,
				signal: preparation.context.signal
			})
		);
	} finally {
		preparation.dispose();
	}

	const { sandbox, kind, label } = resolved;
	const destination = Object.freeze({
		kind,
		id: sandbox.backendId,
		label,
		workspace: sandbox.workspace,
		policyDescription: sandbox.policyDescription
	});

	return Object.freeze<OutsideSandboxExecutor>({
		cleanupBudgets: sandbox.cleanupBudgets,
		destination,
		capabilities: sandbox.capabilities,
		async exec(request: ProcessRequest, options) {
			service.assertLive();

			if (!isOutsideOptions(options)) {
				throw new InvalidApprovalRequestError();
			}

			const { justification, ...input } = options;
			const processOptions = snapshotProcessOptions(input);
			const process = snapshotProcessRequest(request);

			if (
				!sandbox.capabilities.processKinds.includes(process.kind) ||
				(process.kind === 'shell' &&
					!sandbox.capabilities.shells.includes(process.dialect))
			) {
				throw new UnsupportedSandboxCapabilityError({
					operation: 'exec',
					providerId: sandbox.providerId,
					backendId: sandbox.backendId
				});
			}

			const scope = new OperationScope(
				{ operation: 'exec' },
				service.lifetime,
				processOptions,
				120_000,
				sandbox.cleanupBudgets
			);

			try {
				const decision = await requestExecutionApproval(
					pi,
					context,
					{ process, destination, justification },
					{
						signal: scope.context.signal,
						timeoutMs: scope.remainingMs
					}
				);

				scope.check();

				if (decision.kind !== 'allow') {
					throw new ApprovalDeniedError();
				}

				return await sandbox.exec(process, {
					...processOptions,
					signal: scope.context.signal,
					timeoutMs: scope.remainingMs
				});
			} catch (error) {
				if (isSandboxError(error, SandboxCancelledError)) {
					scope.check(error.completion);
				}

				throw error;
			} finally {
				scope.dispose();
			}
		}
	});
}

export function outsideExecutionLifetime(pi: SandboxHost): AbortSignal {
	return outsideService(pi).lifetime;
}

export function trackOutsideExecution<Result>(
	pi: SandboxHost,
	scope: OperationScope,
	execute: () => Promise<Result>
): Promise<Result> {
	return outsideService(pi).track(scope, execute);
}

export async function closeOutsideExecution(
	pi: SandboxHost,
	context: SandboxContext
): Promise<readonly SandboxCloseReport[]> {
	return Promise.all(
		discoverServices(
			pi.events,
			'pi-byos:discovery:v1:outside-execution',
			isOutsideService
		).map((service) => service.close(context))
	);
}

export async function outsideExecutionStatus(
	pi: SandboxHost,
	context: SandboxContext
): Promise<SandboxStatus | undefined> {
	const services = discoverServices(
		pi.events,
		'pi-byos:discovery:v1:outside-execution',
		isOutsideService
	);

	if (services.length > 1) {
		throw new InvalidSandboxDeclarationError({ operation: 'discover' });
	}

	return services[0]?.status(context);
}
