import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import {
	createEventBus,
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { discoverBroker, discoverProviders } from './discovery.js';
import { FixtureConfig } from './fixtures/config.js';
import { imageProvider } from './fixtures/image-provider.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import { bindProtocolAddress } from './protocol-address.js';

it.each([
	{ filesystemScope: 'provider-default', guarantees: [], protection: false },
	{
		filesystemScope: 'system-read-only',
		guarantees: ['no-host-user-data'],
		protection: false
	},
	{
		filesystemScope: 'system-read-only',
		guarantees: ['no-host-user-data'],
		protection: true
	}
] as const)(
	'shares execution contracts across independent SDK instances under $filesystemScope with protection $protection',
	async ({ filesystemScope, guarantees, protection }) => {
		const config = new FixtureConfig();

		await withPiRuntime(
			[
				{
					name: 'provider-and-consumer-copies',
					async factory(pi) {
						const first = await loadSdkInstance();
						const second = await loadSdkInstance();
						const secondClient = second.createSandboxClient(
							pi,
							import.meta.filename
						);
						const template = new MemoryBackend('exec');
						const policy = {
							...template.policy,
							filesystemScope,
							...(protection && {
								workspaceProtection: [{ kind: 'git-metadata' as const }]
							})
						};
						const operations = protection
							? (['exec', 'workspace.protection'] as const)
							: (['exec'] as const);

						first.initialiseSandboxHost(pi, import.meta.filename, {
							cleanup: { disposalTimeoutMs: 9000 }
						});
						config.activate(
							pi,
							{
								...imageProvider,
								id: 'fixture',
								defaultPolicy: policy,
								policies: {
									...imageProvider.policies,
									filesystemScope: [filesystemScope]
								},
								capabilities: {
									operations,
									processKinds: ['shell'],
									shells: ['sh'],
									terminationScope: 'process-group',
									exitStatus: 'optional'
								},
								validateConfig: () => ({ image: 'fixture' }),
								open: () =>
									Promise.resolve({
										id: template.id,
										workspace: template.workspace,
										policy,
										policyDescription: template.policyDescription,
										recovery: template.recovery,
										capabilities: {
											operations,
											processKinds: ['shell'],
											shells: ['sh'],
											terminationScope: 'process-group',
											exitStatus: 'optional'
										},
										exec: (_request, execution) => {
											execution.reportDiagnostic({
												level: 'warning',
												message: 'Independent provider warning'
											});

											return Promise.resolve({
												kind: 'exited',
												exit: { kind: 'unavailable' }
											});
										},
										dispose: () => Promise.resolve()
									})
							},
							first.registerSandboxProvider,
							import.meta.filename
						);
						pi.registerCommand('capabilities-test', {
							description: 'Check independently installed execution contracts.',
							async handler(_arguments, context) {
								const sandbox = await secondClient.get(context, {
									guarantees,
									processKinds: ['shell'],
									shells: ['sh'],
									terminationScope: 'process-group'
								});

								expect(sandbox.policy).toStrictEqual(policy);

								await expect(
									secondClient.get(context, {
										terminationScope: 'workload'
									})
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxCapabilityError'
								});
								expect(
									second.isSandboxError(
										new first.SandboxCancelledError({
											operation: 'exec',
											reason: 'caller',
											completion: 'not-guaranteed'
										}),
										second.SandboxCancelledError
									)
								).toBe(true);

								const result = await sandbox.exec({
									kind: 'shell',
									dialect: 'sh',
									command: 'run'
								});

								const status = await discoverBroker(pi.events)?.status(context);
								const operationId: unknown = expect.any(String);

								expect(status?.diagnostics).toStrictEqual([
									{
										level: 'warning',
										message: 'Independent provider warning',
										operation: 'exec',
										operationId,
										providerId: 'fixture',
										backendId: template.id
									}
								]);
								expect(sandbox.cleanupBudgets).toStrictEqual({
									cancellationGraceMs: 8000,
									disposalTimeoutMs: 9000
								});

								expect({ ...result, durationMs: 0 }).toStrictEqual({
									exit: { kind: 'unavailable' },
									stdout: new Uint8Array(),
									stderr: new Uint8Array(),
									omittedBytes: { stdout: 0, stderr: 0 },
									durationMs: 0
								});
								await expect(
									secondClient.get(context, { processKinds: ['argv'] })
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxCapabilityError'
								});
								await expect(
									secondClient.get(context, { exitStatus: 'guaranteed' })
								).rejects.toMatchObject({
									name: 'UnsupportedSandboxCapabilityError'
								});
							}
						});
					}
				},
				{
					name: 'execution-settings',
					factory: (pi) => {
						config.bind(pi);
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/capabilities-test');
				expect(errors).toStrictEqual([]);
			},
			{
				prepare(_directory, _personal) {
					config.set({
						provider: 'fixture',
						cleanup: { cancellationGraceMs: 8000 }
					});
				}
			}
		);
	}
);

it('interoperates across independent SDK instances and removes failed-factory responders in Pi', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-registration-'));

	try {
		const first = await loadSdkInstance();
		const second = await loadSdkInstance();
		const events = createEventBus();

		bindProtocolAddress(events, import.meta.filename);

		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: path.join(directory, 'agent'),
			settingsManager: SettingsManager.inMemory(),
			eventBus: events,
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			extensionFactories: [
				{
					name: 'first',
					factory: (pi) => {
						first.registerSandboxProvider(pi, import.meta.filename, {
							...imageProvider,
							id: 'first'
						});
					}
				},
				{
					name: 'failed',
					factory: (pi) => {
						second.registerSandboxProvider(pi, import.meta.filename, {
							...imageProvider,
							id: 'failed'
						});

						throw new Error('deliberate factory failure');
					}
				},
				{
					name: 'second',
					factory: (pi) => {
						second.registerSandboxProvider(pi, import.meta.filename, {
							...imageProvider,
							id: 'second'
						});
					}
				}
			]
		});

		await loader.reload();

		const error = new first.SandboxOperationError({
			operation: 'exec'
		});

		expect({
			providers: discoverProviders(events).map((provider) => provider.id),
			loadErrors: loader.getExtensions().errors.map((failure) => failure.error),
			differentConstructors:
				first.SandboxOperationError !== second.SandboxOperationError,
			structuralRecognition: second.isSandboxError(
				error,
				second.SandboxOperationError
			),
			localRecognition: error instanceof first.SandboxOperationError,
			foreignInstanceof: error instanceof second.SandboxOperationError
		}).toStrictEqual({
			providers: ['first', 'second'],
			loadErrors: ['deliberate factory failure'],
			differentConstructors: true,
			structuralRecognition: true,
			localRecognition: true,
			foreignInstanceof: false
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});

it.each([
	['policy', 'provider', 'consumer'],
	['policy', 'consumer', 'provider'],
	['provider', 'policy', 'consumer'],
	['provider', 'consumer', 'policy'],
	['consumer', 'policy', 'provider'],
	['consumer', 'provider', 'policy']
] as const)(
	'shares independent approval and outside execution services in factory order %s, %s, %s',
	async (...order) => {
		const first = await loadSdkInstance();
		const second = await loadSdkInstance();
		const backend = new MemoryBackend('exec');
		let reviews = 0;
		let validations = 0;
		let opens = 0;
		let disposals = 0;

		backend.dispose = () => {
			disposals++;

			return Promise.resolve();
		};

		const factories: Record<(typeof order)[number], InlineExtension> = {
			policy: {
				name: 'approval-policy',
				factory(pi) {
					first.registerApprovalPolicy(pi, import.meta.filename, {
						id: 'fixture',
						label: 'Fixture approval',
						protocolVersion: 1,
						validateConfig(input) {
							expect(input).toBeNull();
							validations++;

							return {};
						},
						decide() {
							reviews++;

							return Promise.resolve({ kind: 'allow' });
						}
					});
				}
			},
			provider: {
				name: 'outside-provider',
				factory(pi) {
					first.registerSandboxProvider(pi, import.meta.filename, {
						id: 'fixture',
						label: 'Fixture sandbox',
						defaultPolicy: backend.policy,
						capabilities: backend.capabilities,
						policies: {
							workspaceAccess: ['read-write'],
							filesystemScope: ['provider-default'],
							networkAccess: ['provider-default']
						},
						validateConfig: () => ({}),
						open: () =>
							Promise.reject(new Error('The ordinary sandbox must not start.')),
						outsideSandbox: {
							label: 'Fixture remote outside execution',
							capabilities: backend.capabilities,
							policy: backend.policy,
							open() {
								opens++;

								return Promise.resolve(backend);
							}
						}
					});
				}
			},
			consumer: {
				name: 'consumer',
				factory(pi) {
					first.createSandboxClient(pi, import.meta.filename);
					second.createSandboxClient(pi, import.meta.filename);
					pi.registerCommand('copies', {
						description: 'Independent SDK fixture',
						async handler(_arguments, context) {
							const a = await first.getOutsideSandboxExecutor(pi, context);
							const b = await second.getOutsideSandboxExecutor(pi, context);

							await a.exec(
								{ kind: 'argv', executable: 'probe', args: [] },
								{ justification: 'First operation.' }
							);
							await b.exec(
								{ kind: 'argv', executable: 'probe', args: [] },
								{ justification: 'Second operation.' }
							);

							const report = await second.closeSandboxSession(pi, context);

							expect({
								sameDestination: a.destination.id === b.destination.id,
								reviews,
								validations,
								opens,
								disposals,
								report,
								foreignError:
									first.ApprovalDeniedError !== second.ApprovalDeniedError,
								recognised: second.isApprovalError(
									new first.ApprovalDeniedError()
								)
							}).toStrictEqual({
								sameDestination: true,
								reviews: 2,
								validations: 1,
								opens: 1,
								disposals: 1,
								report: { confirmed: true, failures: [], recoveries: [] },
								foreignError: true,
								recognised: true
							});
						}
					});
				}
			}
		};

		const config1 = new FixtureConfig();

		await withPiRuntime(
			[
				{
					name: 'host',
					factory(pi) {
						first.initialiseSandboxHost(pi, import.meta.filename, {});
					}
				},
				...order.map((id) => factories[id]),
				{
					name: 'execution-settings',
					factory: (pi) => {
						config1.bind(pi);
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/copies');
				expect(errors).toStrictEqual([]);
			},
			{
				prepare: (_cwd, _agentDirectory) => {
					config1.set({
						provider: 'fixture',
						policy: backend.policy,
						outsideSandbox: { destination: 'provider' },
						approval: {
							policy: 'fixture',
							config: JSON.parse('null') as unknown
						}
					});
				}
			}
		);
	}
);
