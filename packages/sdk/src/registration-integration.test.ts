import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

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
import { fixtureProfile } from './fixtures/profile-fixture.js';
import { fixtureProvider } from './fixtures/register-provider.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import { initialiseSandboxHost } from './host.js';
import { bindProtocolAddress, protocolAddress } from './protocol-address.js';
import {
	collectProtocolReplies,
	PROVIDER_CHANNEL,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';

it.each(['denied', 'read-only'] as const)(
	'shares profile contracts across SDK copies with host system files %s',
	async (hostSystemFiles) => {
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
						const policy = { ...template.policy, hostSystemFiles };
						const profile = fixtureProfile(policy, {
							operations: ['exec'],
							processKinds: ['shell'],
							shells: ['sh'],
							terminationScope: 'process-group',
							exitStatus: 'optional'
						});

						first.initialiseSandboxHost(pi, import.meta.filename, {
							cleanup: { disposalTimeoutMs: 9000 }
						});
						config.activate(
							pi,
							{
								...imageProvider,
								id: 'fixture',

								profiles: { open: [profile], copy: [] },
								validateConfig: () => ({ image: 'fixture' }),
								open: () =>
									Promise.resolve({
										id: template.id,
										workspace: template.workspace,

										policyDescription: template.policyDescription,
										recovery: template.recovery,
										profile,
										exec: (_request, execution) => {
											execution.reportWarning('Independent provider warning');

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
									access: { hostUserData: 'prevented' },
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

it('publishes provider metadata and keeps resolvers and settings out of discovery', async () => {
	const snapshot: unknown[] = [];
	const config = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'private-provider',
				factory(pi) {
					initialiseSandboxHost(pi, import.meta.filename, {});
					config.activate(pi, imageProvider);
					pi.on('session_start', () => {
						const local = protocolAddress(pi.events);
						const [entry] = collectProtocolReplies(
							pi.events,
							PROVIDER_CHANNEL,
							local,
							{
								type: 'get-providers'
							}
						);
						const provider = entry?.payload;
						const services = [
							'get-settings',
							'get-configuration-providers',
							'get-host-options'
						].map((type) =>
							collectProtocolReplies(pi.events, RUNTIME_CHANNEL, local, {
								type
							})
						);

						snapshot.push({ provider, services });
					});
				}
			}
		],
		(_runtime, errors) => {
			expect({ snapshot, errors }).toStrictEqual({
				snapshot: [
					{
						provider: {
							type: 'provider',
							id: imageProvider.id,
							service: {
								id: imageProvider.id,
								label: imageProvider.label,
								profiles: imageProvider.profiles
							}
						},
						services: [[], [], []]
					}
				],
				errors: []
			});

			return Promise.resolve();
		}
	);
});

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
						first.registerSandboxProvider(
							pi,
							import.meta.filename,
							fixtureProvider({
								...imageProvider,
								id: 'first'
							})
						);
					}
				},
				{
					name: 'failed',
					factory: (pi) => {
						second.registerSandboxProvider(
							pi,
							import.meta.filename,
							fixtureProvider({
								...imageProvider,
								id: 'failed'
							})
						);

						throw new Error('deliberate factory failure');
					}
				},
				{
					name: 'second',
					factory: (pi) => {
						second.registerSandboxProvider(
							pi,
							import.meta.filename,
							fixtureProvider({
								...imageProvider,
								id: 'second'
							})
						);
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
