import { mkdtemp, rm } from 'node:fs/promises';
import { writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import {
	createEventBus,
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { discoverProviders } from './discovery.js';
import { imageProvider } from './fixtures/image-provider.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { brokerReply } from './fixtures/protocol-peer.js';
import { loadSdkCopy } from './fixtures/sdk-copy.js';
import type { ensureBroker } from './service.js';

interface BootstrapModule {
	readonly ensureBroker: typeof ensureBroker;
}

function isBootstrapModule(value: unknown): value is BootstrapModule {
	return (
		typeof value === 'object' &&
		value !== null &&
		'ensureBroker' in value &&
		typeof value.ensureBroker === 'function'
	);
}

it('interoperates across physical SDK copies and removes failed-factory responders in Pi', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-registration-'));

	try {
		const first = await loadSdkCopy(path.join(directory, 'first'));
		const second = await loadSdkCopy(path.join(directory, 'second'));
		const events = createEventBus();
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
						first.registerSandboxProvider(pi, {
							...imageProvider,
							id: 'first'
						});
					}
				},
				{
					name: 'failed',
					factory: (pi) => {
						second.registerSandboxProvider(pi, {
							...imageProvider,
							id: 'failed'
						});

						throw new Error('deliberate factory failure');
					}
				},
				{
					name: 'second',
					factory: (pi) => {
						second.registerSandboxProvider(pi, {
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

it('publishes one service during concurrent bootstrap through independent SDK copies', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-bootstrap-'));

	try {
		const copies = [
			path.join(directory, 'first'),
			path.join(directory, 'second')
		];

		await Promise.all(copies.map((copy) => loadSdkCopy(copy)));

		const modules: readonly unknown[] = await Promise.all(
			copies.map(
				(copy) => import(pathToFileURL(path.join(copy, 'service.js')).href)
			)
		);
		const events = createEventBus();
		let constructions = 0;
		const services = await Promise.all(
			modules.map((module) => {
				if (!isBootstrapModule(module)) {
					throw new TypeError(
						'The compiled service module has no bootstrap function.'
					);
				}

				return Promise.try(() =>
					module.ensureBroker(events, (id) => {
						constructions++;

						return brokerReply(id).service;
					})
				);
			})
		);

		expect({
			ids: services.map((service) => service.id),
			constructions
		}).toStrictEqual({
			ids: [services[0]?.id, services[0]?.id],
			constructions: 1
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
		const directory = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-approval-copies-')
		);

		try {
			const first = await loadSdkCopy(path.join(directory, 'first'));
			const second = await loadSdkCopy(path.join(directory, 'second'));
			const backend = new MemoryBackend('exec');
			let reviews = 0;
			let validations = 0;
			let opens = 0;
			let disposals = 0;
			let personalDirectory = '';

			backend.dispose = () => {
				disposals++;

				return Promise.resolve();
			};

			const factories: Record<(typeof order)[number], InlineExtension> = {
				policy: {
					name: 'approval-policy',
					factory(pi) {
						first.registerApprovalPolicy(pi, {
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
						first.registerSandboxProvider(pi, {
							id: 'fixture',
							label: 'Fixture sandbox',
							protocolVersion: 1,
							capabilities: backend.capabilities,
							policies: {
								workspaceAccess: ['read-write'],
								filesystemScope: ['provider-default'],
								networkAccess: ['provider-default']
							},
							validateConfig: () => ({}),
							open: () =>
								Promise.reject(
									new Error('The ordinary sandbox must not start.')
								),
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

			await withPiRuntime(
				[
					{
						name: 'host',
						factory(pi) {
							first.initialiseSandboxHost(pi, {
								agentDirectory: personalDirectory
							});
						}
					},
					...order.map((id) => factories[id])
				],
				async (runtime, errors) => {
					await runtime.session.prompt('/copies');
					expect(errors).toStrictEqual([]);
				},
				{
					prepare: async (_cwd, agentDirectory) => {
						personalDirectory = agentDirectory;
						await writeFile(
							path.join(agentDirectory, 'byos.json'),
							JSON.stringify({
								provider: 'fixture',
								policy: backend.policy,
								outsideSandbox: { destination: 'provider' },
								approval: {
									policy: 'fixture',
									config: JSON.parse('null') as unknown
								}
							})
						);
					}
				}
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
