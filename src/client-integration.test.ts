import { access, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	AgentSessionRuntime,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { createReadTool } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import type { SandboxContext, SandboxHost } from './api.js';
import {
	closeSandboxSession,
	getSandbox,
	initialiseSandboxHost,
	InvalidSandboxRequestError,
	registerSandboxProvider,
	SandboxInitialisationError,
	SandboxStartupError
} from './api.js';
import { discoverBroker } from './discovery.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { loadSdkCopy } from './fixtures/sdk-copy.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

it.each(['', 'relative', '/tmp/invalid\0directory'])(
	'rejects invalid host directory %j before publishing a service',
	async (agentDirectory) => {
		await fixture(async ({ pi }) => {
			expect(() => {
				initialiseSandboxHost(pi, { agentDirectory });
			}).toThrow(InvalidSandboxRequestError);
			expect(discoverBroker(pi.events)).toBeUndefined();
			await Promise.resolve();
		});
	}
);

it('binds independent runtime directories across SDK copies without changing the process default', async () => {
	expect(initialiseSandboxHost).toBeTypeOf('function');
	vi.stubEnv('PI_CODING_AGENT_DIR', '/missing/byos-process-default');
	await Promise.all(
		['first', 'second'].map(async (providerId) => {
			let agentDirectory = '';
			let host: SandboxHost | undefined;
			let liveContext: SandboxContext | undefined;

			await withPiRuntime(
				[
					{
						name: 'host-binding',
						factory(pi) {
							host = pi;
							initialiseSandboxHost(pi, { agentDirectory });
							pi.on('session_start', (_event, context) => {
								liveContext = context;
							});
						}
					}
				],
				async () => {
					if (host === undefined || liveContext === undefined) {
						throw new Error('Pi did not initialise the host fixture.');
					}

					const copy = await loadSdkCopy(
						path.join(liveContext.cwd, 'sdk-copy')
					);

					await expect(
						copy.getSandbox(host, liveContext)
					).rejects.toMatchObject({
						name: 'ProviderNotFoundError',
						providerId
					});

					const pi = host;

					expect(() => {
						initialiseSandboxHost(pi, { agentDirectory });
					}).toThrow(SandboxInitialisationError);
				},
				{
					async prepare(_directory, runtimeDirectory) {
						agentDirectory = runtimeDirectory;
						await writeFile(
							path.join(agentDirectory, 'byos.json'),
							JSON.stringify({
								...fixtureConfig,
								provider: providerId
							})
						);
					}
				}
			);
		})
	);
});

interface ClientFixture {
	readonly pi: SandboxHost;
	readonly context: SandboxContext;
	readonly runtime: AgentSessionRuntime;
	readonly errors: readonly unknown[];
}

async function fixture(
	execute: (fixture: ClientFixture) => Promise<void>,
	extensions: readonly InlineExtension[] = []
): Promise<void> {
	const current: { pi?: SandboxHost; context?: SandboxContext } = {};

	await withPiRuntime(
		[
			{
				name: 'sdk-consumer',
				factory(pi) {
					current.pi = pi;
					pi.on('session_start', (_event, context) => {
						current.context = context;
					});
				}
			},
			...extensions
		],
		async (runtime, errors) => {
			const { pi, context } = current;

			if (pi === undefined || context === undefined) {
				throw new Error('Pi did not initialise the consumer fixture.');
			}

			vi.stubEnv('PI_CODING_AGENT_DIR', path.join(context.cwd, 'agent'));
			await execute({ pi, context, runtime, errors });
		}
	);
}

function provider(open: () => Promise<MemoryBackend>): InlineExtension {
	const template = new MemoryBackend();

	return {
		name: 'fixture-provider',
		factory(pi) {
			registerSandboxProvider(pi, {
				id: 'fixture',
				label: 'Fixture',
				protocolVersion: 1,
				capabilities: template.capabilities,
				policies: {
					workspaceAccess: ['read-write'],
					filesystemScope: ['provider-default'],
					networkAccess: ['provider-default']
				},
				validateConfig: () => ({}),
				open
			});
		}
	};
}

async function selectFixtureProvider(context: SandboxContext): Promise<void> {
	await writeFile(
		path.join(context.cwd, 'agent', 'byos.json'),
		JSON.stringify(fixtureConfig)
	);
}

const fixtureConfig = {
	provider: 'fixture',
	policy: {
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	}
};

it('provides a shared host backend with only a consumer and no configuration', async () => {
	await fixture(async ({ pi, context, errors }) => {
		expect(discoverBroker(pi.events)).toBeUndefined();

		const [first, second] = await Promise.all([
			getSandbox(pi, context),
			getSandbox(pi, context)
		]);

		await first.files.writeFile(
			'result',
			new TextEncoder().encode('host content')
		);

		const result = await second.exec({
			kind: 'argv',
			executable: process.execPath,
			args: [
				'-e',
				'process.stdout.write(require("node:fs").readFileSync("result"))'
			]
		});

		expect({
			errors,
			provider: first.providerId,
			sharedGeneration: first.generationId === second.generationId,
			sharedBackend: first.backendId === second.backendId,
			exit: result.exit,
			output: new TextDecoder().decode(result.stdout),
			host: await readFile(path.join(context.cwd, 'result'), 'utf8')
		}).toStrictEqual({
			errors: [],
			provider: 'passthrough',
			sharedGeneration: true,
			sharedBackend: true,
			exit: { kind: 'code', code: 0 },
			output: 'host content',
			host: 'host content'
		});
	});
});

it('uses the same consumer operations with a configured provider and no broker extension', async () => {
	const backend = new MemoryBackend();

	await fixture(
		async ({ pi, context, errors }) => {
			await selectFixtureProvider(context);

			const sandbox = await getSandbox(pi, context);

			await sandbox.files.writeFile(
				'result',
				new TextEncoder().encode('remote content')
			);
			expect({
				errors,
				provider: sandbox.providerId,
				result: new TextDecoder().decode(
					await sandbox.files.readFile('result')
				),
				calls: backend.calls
			}).toStrictEqual({
				errors: [],
				provider: 'fixture',
				result: 'remote content',
				calls: [
					{ operation: 'writeFile', path: '/remote/project/result' },
					{ operation: 'readFile', path: '/remote/project/result' }
				]
			});
			await expect(
				access(path.join(context.cwd, 'result'))
			).rejects.toMatchObject({ code: 'ENOENT' });
		},
		[provider(() => Promise.resolve(backend))]
	);
});

it('keeps an installed but unselected provider idle', async () => {
	let opens = 0;

	await fixture(
		async ({ pi, context }) => {
			const sandbox = await getSandbox(pi, context);

			expect({ provider: sandbox.providerId, opens }).toStrictEqual({
				provider: 'passthrough',
				opens: 0
			});
		},
		[
			provider(() => {
				opens++;

				return Promise.resolve(new MemoryBackend());
			})
		]
	);
});

it.each(['missing', 'startup'] as const)(
	'persists an explicit provider %s failure without executing on the host',
	async (failure) => {
		await fixture(
			async ({ pi, context }) => {
				await selectFixtureProvider(context);

				const name =
					failure === 'missing'
						? 'ProviderNotFoundError'
						: 'SandboxStartupError';

				await expect(getSandbox(pi, context)).rejects.toMatchObject({
					name,
					providerId: 'fixture',
					configurationSource: 'personal'
				});
				await expect(getSandbox(pi, context)).rejects.toMatchObject({
					name,
					providerId: 'fixture'
				});

				const broker = discoverBroker(pi.events);
				const status = await broker?.status(context);

				expect({
					state: status?.state,
					backendId: status?.backendId
				}).toStrictEqual({ state: 'failed', backendId: undefined });
			},
			failure === 'startup'
				? [
						provider(() =>
							Promise.reject(
								new SandboxStartupError({
									operation: 'open',
									providerId: 'fixture'
								})
							)
						)
					]
				: []
		);
	}
);

it.each(['{', '{"provider":null}', '{"unexpected":true}'])(
	'rejects invalid configuration before selecting host execution: %s',
	async (config) => {
		await fixture(async ({ pi, context }) => {
			await writeFile(path.join(context.cwd, 'agent', 'byos.json'), config);
			await expect(getSandbox(pi, context)).rejects.toMatchObject({
				name: 'InvalidSandboxConfigError',
				configurationSource: 'personal'
			});
		});
	}
);

it('closes explicitly before raw disposal and keeps a closed service until invalidation', async () => {
	await fixture(async ({ pi, context, runtime }) => {
		const sandbox = await getSandbox(pi, context);
		const report = await closeSandboxSession(pi, context);

		expect({
			report,
			repeated: await closeSandboxSession(pi, context)
		}).toStrictEqual({
			report: { confirmed: true, recoveries: [], failures: [] },
			repeated: { confirmed: true, recoveries: [], failures: [] }
		});
		await expect(getSandbox(pi, context)).rejects.toMatchObject({
			name: 'SandboxSessionClosingError'
		});
		runtime.session.dispose();
		await expect(sandbox.files.readFile('result')).rejects.toMatchObject({
			name: 'StaleSandboxHandleError'
		});
	});
});

it('shares consumer-only startup across physical SDK copies', async () => {
	await fixture(async ({ pi, context }) => {
		const [first, second] = await Promise.all([
			loadSdkCopy(path.join(context.cwd, 'first-sdk')),
			loadSdkCopy(path.join(context.cwd, 'second-sdk'))
		]);
		const [left, right] = await Promise.all([
			first.getSandbox(pi, context),
			second.getSandbox(pi, context)
		]);

		await left.files.writeFile(
			'shared',
			new TextEncoder().encode('shared content')
		);
		expect({
			separateCopies: first.getSandbox !== second.getSandbox,
			sameGeneration: left.generationId === right.generationId,
			sameBackend: left.backendId === right.backendId,
			content: new TextDecoder().decode(await right.files.readFile('shared'))
		}).toStrictEqual({
			separateCopies: true,
			sameGeneration: true,
			sameBackend: true,
			content: 'shared content'
		});
		expect(await second.closeSandboxSession(pi, context)).toStrictEqual({
			confirmed: true,
			recoveries: [],
			failures: []
		});
		await expect(first.getSandbox(pi, context)).rejects.toMatchObject({
			name: 'SandboxSessionClosingError'
		});
	});
});

it('keeps concurrent Pi sessions in separate generations and workspaces', async () => {
	await fixture(async (first) => {
		const left = await getSandbox(first.pi, first.context);

		await fixture(async (second) => {
			const right = await getSandbox(second.pi, second.context);

			await Promise.all([
				left.files.writeFile('file', new Uint8Array([1])),
				right.files.writeFile('file', new Uint8Array([2]))
			]);
			expect({
				distinctGeneration: left.generationId !== right.generationId,
				distinctBackend: left.backendId !== right.backendId,
				left: await left.files.readFile('file'),
				right: await right.files.readFile('file')
			}).toStrictEqual({
				distinctGeneration: true,
				distinctBackend: true,
				left: new Uint8Array([1]),
				right: new Uint8Array([2])
			});
		});
	});
});

it.each([true, false])(
	'drives an unconfigured SDK consumer with a scripted model and approval: %s',
	async (isAllowed) => {
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'consumer-call',
				name: 'consumer_read',
				arguments: { path: 'result' }
			}
		]);
		const consumer: InlineExtension = {
			name: 'model-consumer',
			factory(pi) {
				pi.registerTool({
					name: 'consumer_read',
					label: 'Read sandbox data',
					description: 'Read a file through the selected sandbox.',
					parameters: createReadTool('/unused').parameters,
					async execute(_id, input, signal, _update, context) {
						const options = signal === undefined ? {} : { signal };
						const sandbox = await getSandbox(pi, context, options);
						const bytes = await sandbox.files.readFile(input.path, options);

						return {
							content: [
								{ type: 'text', text: new TextDecoder().decode(bytes) }
							],
							details: {}
						};
					}
				});
				pi.on('tool_call', (event) =>
					!isAllowed && event.toolName === 'consumer_read'
						? { block: true, reason: 'Denied by the fake approver.' }
						: undefined
				);
			}
		};

		await fixture(
			async ({ pi, context, runtime, errors }) => {
				await writeFile(path.join(context.cwd, 'result'), 'host data');

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Read the sandbox data.');

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						isError: message.isError,
						content: message.content
					}));

				expect({
					errors,
					hasBroker: discoverBroker(pi.events) !== undefined,
					requests: model.requests.length,
					results
				}).toStrictEqual({
					errors: [],
					hasBroker: isAllowed,
					requests: 2,
					results: [
						{
							isError: !isAllowed,
							content: [
								{
									type: 'text',
									text: isAllowed ? 'host data' : 'Denied by the fake approver.'
								}
							]
						}
					]
				});
			},
			[consumer, model.extension]
		);
	}
);
