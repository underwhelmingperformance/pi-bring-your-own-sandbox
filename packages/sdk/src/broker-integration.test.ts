import { readdir } from 'node:fs/promises';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { snapshotBackend } from './backend-snapshot.js';
import { SandboxBroker } from './broker.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxClient,
	SandboxContext
} from './contracts.js';
import { discoverProviders } from './discovery.js';
import { InvalidSandboxConfigError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import type { BrokerServiceV1 } from './protocol.js';
import { registerSandboxProvider } from './provider-registration.js';
import { ensureBroker } from './service.js';
import { isRecord } from './validation.js';

it('keeps model catalog refreshes in memory in the Pi fixture', async () => {
	await withPiRuntime([], async (runtime) => {
		await runtime.session.modelRuntime.refresh({ allowNetwork: false });
		expect(await readdir(runtime.services.agentDir)).toStrictEqual([]);
	});
});

interface FixtureClients {
	readonly provider: SandboxClient;
	readonly consumer: SandboxClient;
}

function fixture(
	order: readonly ('broker' | 'provider' | 'consumer')[],
	clients?: FixtureClients
) {
	const template = new MemoryBackend();
	const sandboxes: Sandbox[] = [];
	const contexts: SandboxContext[] = [];
	const services: BrokerServiceV1[] = [];
	const backends: MemoryBackend[] = [];
	let opens = 0;
	let disposals = 0;
	let configurations = 0;
	const extensions: InlineExtension[] = order.map((role) => ({
		name: role,
		factory(pi) {
			const service = () =>
				ensureBroker(pi.events, (id) => {
					const broker = new SandboxBroker(id, pi, {
						providers: () => discoverProviders(pi.events),
						readConfig: () =>
							Promise.resolve({
								selection: {
									providerId: 'fixture',
									source: 'extension',
									policy: template.policy
								},
								providerConfig: {}
							})
					});

					services.push(broker);

					return broker;
				});

			if (role === 'broker') {
				service();

				return;
			}

			if (role === 'provider') {
				const register =
					clients?.provider.registerSandboxProvider ?? registerSandboxProvider;

				register(pi, {
					id: 'fixture',
					label: 'Fixture',
					protocolVersion: 1,
					capabilities: template.capabilities,
					policies: {
						workspaceAccess: ['read-write'],
						filesystemScope: ['provider-default'],
						networkAccess: ['provider-default']
					},
					validateConfig(input: unknown): Record<string, never> {
						configurations++;

						if (!isRecord(input) || Object.keys(input).length > 0) {
							throw new InvalidSandboxConfigError({ operation: 'configure' });
						}

						return {};
					},
					open: () => {
						opens++;

						const backend = new MemoryBackend();

						backends.push(backend);
						backend.seed('file', new TextEncoder().encode('remote content'));

						return Promise.resolve({
							...snapshotBackend(backend),
							id: `memory:${String(opens)}`,
							dispose: () => {
								disposals++;

								return Promise.resolve();
							}
						});
					}
				});

				return;
			}

			const acquire = (
				context: SandboxContext,
				options?: SandboxAcquireOptions
			) =>
				clients === undefined
					? service().acquire(context, options)
					: clients.consumer.getSandbox(pi, context, options);

			pi.registerTool({
				name: 'sandbox_read',
				label: 'Sandbox read',
				description: 'Read a file from the selected sandbox.',
				parameters: createReadTool('/unused').parameters,
				async execute(_id, input, signal, _update, context) {
					const options = signal === undefined ? {} : { signal };
					const sandbox = await acquire(context, options);
					const bytes = await sandbox.files.readFile(input.path, options);

					return {
						content: [{ type: 'text', text: new TextDecoder().decode(bytes) }],
						details: {}
					};
				}
			});
			pi.registerTool({
				name: 'sandbox_nested',
				label: 'Nested sandbox read',
				description: 'Read a sandbox file through another Pi tool.',
				parameters: createReadTool('/unused').parameters,
				async execute(_id, input, _signal, _update, context) {
					const result = await context.executeTool('sandbox_read', input);

					return { ...result.result, isError: result.isError, details: {} };
				}
			});
			pi.on('session_start', async (_event, context) => {
				contexts.push(context);
				sandboxes.push(await acquire(context));
			});
		}
	}));

	return {
		extensions,
		sandboxes,
		contexts,
		services,
		backends,
		counts: () => ({ opens, disposals, configurations })
	};
}

it.each([
	{ tool: 'sandbox_read', isAllowed: true },
	{ tool: 'sandbox_read', isAllowed: false },
	{ tool: 'sandbox_nested', isAllowed: true },
	{ tool: 'sandbox_nested', isAllowed: false }
])(
	'applies approval to model-issued $tool calls: $isAllowed',
	async ({ tool, isAllowed }) => {
		const { extensions, backends } = fixture(['consumer', 'provider']);
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'scripted-call',
				name: tool,
				arguments: { path: 'file' }
			}
		]);
		const calls: { tool: string; id: string; parent: string | undefined }[] =
			[];
		const approver: InlineExtension = {
			name: 'fake-approver',
			factory(pi) {
				pi.on('tool_call', (event) => {
					calls.push({
						tool: event.toolName,
						id: event.toolCallId,
						parent: event.parentToolCallId
					});

					return !isAllowed && event.toolName === 'sandbox_read'
						? { block: true, reason: 'Denied by the fake approver.' }
						: undefined;
				});
			}
		};

		await withPiRuntime(
			[...extensions, model.extension, approver],
			async (runtime, errors) => {
				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Read the sandbox file.');

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						tool: message.toolName,
						isError: message.isError,
						content: message.content,
						nested: message.nestedCalls?.calls.map((call) => ({
							id: call.id,
							name: call.name,
							status: call.status
						}))
					}));
				const isNested = tool === 'sandbox_nested';

				expect({
					errors,
					requests: model.requests.length,
					calls,
					backendCalls: backends.flatMap((backend) => backend.calls),
					results
				}).toStrictEqual({
					errors: [],
					requests: 2,
					calls: [
						{ tool, id: 'scripted-call', parent: undefined },
						...(isNested
							? [
									{
										tool: 'sandbox_read',
										id: 'scripted-call/1',
										parent: 'scripted-call'
									}
								]
							: [])
					],
					backendCalls: isAllowed
						? [{ operation: 'readFile', path: '/remote/project/file' }]
						: [],
					results: [
						{
							tool,
							isError: !isAllowed,
							content: [
								{
									type: 'text',
									text: isAllowed
										? 'remote content'
										: 'Denied by the fake approver.'
								}
							],
							nested: isNested
								? [
										{
											id: 'scripted-call/1',
											name: 'sandbox_read',
											status: isAllowed ? 'ok' : 'error'
										}
									]
								: undefined
						}
					]
				});
			}
		);
	}
);

it.each([
	['broker', 'provider', 'consumer'],
	['broker', 'consumer', 'provider'],
	['provider', 'broker', 'consumer'],
	['provider', 'consumer', 'broker'],
	['consumer', 'broker', 'provider'],
	['consumer', 'provider', 'broker']
] as const)(
	'supports factory order %s, %s, %s across SDK copies in Pi',
	async (...order) => {
		const [provider, consumer] = await Promise.all([
			loadSdkInstance(),
			loadSdkInstance()
		]);
		let registrations = 0;
		let acquisitions = 0;
		const clients: FixtureClients = {
			provider: {
				...provider,
				registerSandboxProvider(pi, declaration) {
					registrations++;
					provider.registerSandboxProvider(pi, declaration);
				}
			},
			consumer: {
				...consumer,
				getSandbox(pi, context, options) {
					acquisitions++;

					return consumer.getSandbox(pi, context, options);
				}
			}
		};
		const { extensions, sandboxes, contexts, services, counts } = fixture(
			order,
			clients
		);

		await withPiRuntime(extensions, async (runtime, errors) => {
			const sandbox = sandboxes[0];
			const context = contexts[0];
			const service = services[0];

			if (
				sandbox === undefined ||
				context === undefined ||
				service === undefined
			) {
				throw new Error(
					'The Pi start handlers did not publish the expected sandbox.'
				);
			}

			expect({
				errors,
				separateCopies: provider.getSandbox !== consumer.getSandbox,
				registrations,
				acquisitions,
				sandboxIds: sandboxes.map((value) => value.backendId),
				services: services.length,
				...counts()
			}).toStrictEqual({
				errors: [],
				separateCopies: true,
				registrations: 1,
				acquisitions: 1,
				sandboxIds: ['memory:1'],
				services: 1,
				opens: 1,
				disposals: 0,
				configurations: 1
			});
			expect(await sandbox.files.readFile('file')).toStrictEqual(
				new TextEncoder().encode('remote content')
			);
			await runtime.session.extensionRunner.emit({
				type: 'session_shutdown',
				reason: 'quit'
			});
			await expect(service.acquire(context)).rejects.toMatchObject({
				name: 'SandboxSessionClosingError'
			});

			const status = await service.status(context);

			expect({ state: status.state, ...counts() }).toStrictEqual({
				state: 'closed',
				opens: 1,
				disposals: 1,
				configurations: 1
			});
		});
	}
);

it('bootstraps from a consumer without a broker extension and creates fresh leases for new sessions', async () => {
	const { extensions, sandboxes, counts } = fixture(['consumer', 'provider']);

	await withPiRuntime(extensions, async (runtime, errors) => {
		const first = sandboxes[0];

		if (first === undefined) {
			throw new Error('The initial consumer did not acquire a sandbox.');
		}

		expect(await runtime.newSession()).toStrictEqual({ cancelled: false });

		const second = sandboxes[1];

		if (second === undefined) {
			throw new Error('The replacement consumer did not acquire a sandbox.');
		}

		expect({
			errors,
			differentGeneration: first.generationId !== second.generationId,
			backendIds: sandboxes.map((sandbox) => sandbox.backendId),
			...counts()
		}).toStrictEqual({
			errors: [],
			differentGeneration: true,
			backendIds: ['memory:1', 'memory:2'],
			opens: 2,
			disposals: 1,
			configurations: 2
		});
		await expect(
			first.exec({ kind: 'argv', executable: 'program', args: [] })
		).rejects.toMatchObject({ name: 'StaleSandboxHandleError' });
	});
});

it('recreates the broker on Pi reload and leaves raw disposal cleanup to the embedding host', async () => {
	const { extensions, sandboxes, counts } = fixture(['consumer', 'provider']);

	await withPiRuntime(extensions, async (runtime, errors) => {
		await runtime.session.reload();

		const sandbox = sandboxes[1];

		if (sandbox === undefined) {
			throw new Error('The reloaded consumer did not acquire a sandbox.');
		}

		expect({ errors, ...counts() }).toStrictEqual({
			errors: [],
			opens: 2,
			disposals: 1,
			configurations: 2
		});
		runtime.session.dispose();
		await expect(sandbox.files.readFile('file')).rejects.toMatchObject({
			name: 'StaleSandboxHandleError'
		});
		expect(counts()).toStrictEqual({
			opens: 2,
			disposals: 1,
			configurations: 2
		});
	});
});

it.each([
	{ failsCleanup: true, isBusy: false },
	{ failsCleanup: false, isBusy: false },
	{ failsCleanup: true, isBusy: true }
])(
	'reports cleanup during Pi shutdown: failure $failsCleanup, active turn $isBusy',
	async ({ failsCleanup, isBusy }) => {
		const template = new MemoryBackend('exec');
		const recovery = {
			kind: 'allocation',
			id: 'shutdown-allocation',
			lease: 'manual cleanup',
			instructions: 'Remove shutdown-allocation.'
		} as const;
		let disposals = 0;
		const extension: InlineExtension = {
			name: 'shutdown-fixture',
			factory(pi) {
				const broker = new SandboxBroker('broker', pi, {
					readConfig: () =>
						Promise.resolve({
							selection: {
								providerId: 'fixture',
								source: 'extension',
								policy: template.policy
							},
							providerConfig: {}
						}),
					providers: () => [
						{
							id: 'fixture',
							label: 'Fixture',
							capabilities: template.capabilities,
							policies: {
								workspaceAccess: ['read-write'],
								filesystemScope: ['provider-default'],
								networkAccess: ['provider-default']
							},
							configure: () => ({
								open: (_request, opening) => {
									opening.reportRecovery(recovery);

									return Promise.resolve({
										...snapshotBackend(template),
										recovery,
										dispose: () => {
											disposals++;

											return failsCleanup
												? Promise.reject(new Error('PRIVATE_PROVIDER_TOKEN'))
												: Promise.resolve();
										}
									});
								}
							})
						}
					]
				});

				pi.on('session_start', async (_event, context) => {
					await broker.acquire(context);
				});
			}
		};

		const content = [
			'Cleanup: incomplete',
			'Cleanup error: SandboxCleanupError: Sandbox cleanup could not be confirmed. Check the recovery descriptor.',
			'Recovery: shutdown-allocation (lease manual cleanup)',
			'Remove shutdown-allocation.'
		].join('\n');

		await withPiRuntime([extension], async (runtime, errors) => {
			const session = runtime.session;
			const isIdle = vi
				.spyOn(session, 'isIdle', 'get')
				.mockReturnValue(!isBusy);
			const isStreaming = vi
				.spyOn(session, 'isStreaming', 'get')
				.mockReturnValue(isBusy);

			try {
				await runtime.dispose();

				const messages = session.messages
					.filter((message) => message.role === 'custom')
					.map(({ content, display }) => ({ content, display }));
				const entries = session.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === 'custom' && entry.customType === 'byos-cleanup'
							? [entry.data]
							: []
					);

				expect({ disposals, errors, messages, entries }).toStrictEqual({
					disposals: 1,
					errors: [],
					messages: failsCleanup && !isBusy ? [{ display: true, content }] : [],
					entries: failsCleanup && isBusy ? [{ content }] : []
				});
			} finally {
				isIdle.mockRestore();
				isStreaming.mockRestore();
			}
		});
	}
);
