import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	ExtensionAPI,
	InlineExtension,
	ToolResultEvent
} from '@earendil-works/pi-coding-agent';
import {
	createBashTool,
	createBashToolDefinition,
	DEFAULT_MAX_BYTES
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import {
	registerSandboxProvider,
	SandboxCancelledError,
	SandboxTransportError
} from './api.js';
import type {
	BackendProcessContext,
	ProcessRequest,
	SandboxBackend
} from './contracts.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { createShellOperations } from './pi-shell-operations.js';
import sandboxTools from './pi-tools.js';
import { isRecord } from './validation.js';

function shellBackend(output = 'target output') {
	const template = new MemoryBackend('exec');
	const requests: ProcessRequest[] = [];
	const backend: SandboxBackend = {
		id: template.id,
		workspace: template.workspace,
		policy: template.policy,
		policyDescription: template.policyDescription,
		recovery: template.recovery,
		capabilities: { operations: ['exec'], shells: ['bash', 'powershell'] },
		exec(request: ProcessRequest, context: BackendProcessContext) {
			requests.push(request);
			context.onOutput({
				stream: 'stdout',
				data: new TextEncoder().encode(output)
			});

			return Promise.resolve({
				kind: 'exited',
				exit: { kind: 'code', code: 0 }
			});
		},
		dispose: () => Promise.resolve()
	};

	return { backend, requests };
}

function provider(backend: SandboxBackend): InlineExtension {
	return {
		name: 'target-provider',
		factory(pi) {
			registerSandboxProvider(pi, {
				id: 'fixture',
				label: 'In-memory shell; no OS isolation.',
				protocolVersion: 1,
				capabilities: backend.capabilities,
				policies: {
					workspaceAccess: ['read-write'],
					filesystemScope: ['provider-default'],
					networkAccess: ['provider-default']
				},
				validateConfig: () => ({}),
				open: () => Promise.resolve(backend)
			});
		}
	};
}

async function prepare(
	_directory: string,
	agentDirectory: string
): Promise<void> {
	vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
	await writeFile(
		path.join(agentDirectory, 'byos.json'),
		JSON.stringify({
			provider: 'fixture',
			policy: {
				workspaceAccess: 'read-write',
				filesystemScope: 'provider-default',
				networkAccess: 'provider-default'
			}
		})
	);
}

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

it.each(['confirmed', 'unconfirmed'] as const)(
	'preserves timeout output and termination status: %s',
	async (termination) => {
		const { backend } = shellBackend();
		const started = Promise.withResolvers<undefined>();
		const waiting: SandboxBackend = {
			...backend,
			exec(_request, context) {
				context.onOutput({
					stream: 'stdout',
					data: new TextEncoder().encode('valuable diagnostic\n')
				});
				started.resolve(undefined);

				return new Promise((resolve) => {
					context.signal.addEventListener(
						'abort',
						() => {
							resolve({ kind: 'cancelled', termination });
						},
						{ once: true }
					);
				});
			}
		};
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'timeout',
				name: 'bash',
				arguments: { command: 'long build', timeout: 0.05 }
			}
		]);

		await withPiRuntime(
			[
				provider(waiting),
				{ name: 'shell', factory: sandboxTools },
				model.extension
			],
			async (runtime) => {
				runtime.session.setActiveToolsByName(['bash']);

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				vi.useFakeTimers();

				const running = runtime.session.prompt('Run the build.');

				await started.promise;
				await vi.advanceTimersByTimeAsync(50);
				await running;
				vi.useRealTimers();

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map(({ content, isError }) => ({ content, isError }));

				expect(results).toStrictEqual([
					{
						content: [
							{
								type: 'text',
								text:
									termination === 'confirmed'
										? 'valuable diagnostic\n\n\nCommand timed out after 0.05 seconds'
										: 'The sandbox did not confirm termination. Operation completion is unknown.'
							}
						],
						isError: true
					}
				]);
			},
			{ prepare }
		);
	}
);

it('preserves output when Pi shell operations receive confirmed cancellation', async () => {
	const { backend } = shellBackend();
	const cancelled: SandboxBackend = {
		...backend,
		exec(_request, context) {
			context.onOutput({
				stream: 'stdout',
				data: new TextEncoder().encode('cancel diagnostic\n')
			});

			return Promise.reject(
				new SandboxCancelledError({
					operation: 'exec',
					reason: 'caller',
					completion: 'confirmed'
				})
			);
		}
	};

	await withPiRuntime(
		[
			provider(cancelled),
			{
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('cancel-test', {
						description: 'Exercise the shell operation boundary.',
						async handler(_arguments, context) {
							const tool = createBashTool(context.cwd, {
								operations: createShellOperations(pi, context, 'bash')
							});

							await expect(
								tool.execute('cancel', { command: 'cancelled build' })
							).rejects.toThrow('cancel diagnostic\n\n\nCommand aborted');
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/cancel-test');
			expect(errors).toStrictEqual([]);
		},
		{ prepare }
	);
});

it.each([
	{ tool: 'bash', isAllowed: true },
	{ tool: 'bash', isAllowed: false },
	{ tool: 'powershell', isAllowed: true },
	{ tool: 'powershell', isAllowed: false }
])(
	'delegates $tool through public Pi operations and approval: $isAllowed',
	async ({ tool, isAllowed }) => {
		const { backend, requests } = shellBackend();
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'shell-call',
				name: tool,
				arguments: { command: 'printf target' }
			}
		]);
		const structured: ToolResultEvent['structuredContent'][] = [];
		const approver: InlineExtension = {
			name: 'fake-approver',
			factory(pi) {
				pi.on('tool_call', () =>
					isAllowed
						? undefined
						: { block: true, reason: 'Denied by the fake approver.' }
				);
				pi.on('tool_result', (event) => {
					structured.push(event.structuredContent);
				});
			}
		};

		await withPiRuntime(
			[
				provider(backend),
				{ name: 'sandbox-tools', factory: sandboxTools },
				model.extension,
				approver
			],
			async (runtime, errors) => {
				runtime.session.setActiveToolsByName([tool]);

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Run the shell tool.');

				const measuredTime: unknown = expect.any(Number);
				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						content: message.content,
						isError: message.isError
					}));

				expect({ errors, requests, results, structured }).toStrictEqual({
					errors: [],
					requests: isAllowed
						? [
								{
									kind: 'shell',
									dialect: tool,
									command: 'printf target',
									cwd: '/remote/project'
								}
							]
						: [],
					results: [
						{
							content: [
								{
									type: 'text',
									text: isAllowed
										? 'target output'
										: 'Denied by the fake approver.'
								}
							],
							isError: !isAllowed
						}
					],
					structured: isAllowed
						? [
								{
									output: 'target output',
									truncated: false,
									exit_code: 0,
									wall_time_seconds: measuredTime
								}
							]
						: []
				});
			},
			{ prepare }
		);
	}
);

it.each([
	{
		includeBuiltins: true,
		tools: undefined,
		expected: ['read', 'bash', 'edit', 'write']
	},
	{ includeBuiltins: false, tools: undefined, expected: [] },
	{ includeBuiltins: true, tools: [], expected: [] },
	{ includeBuiltins: true, tools: ['read'], expected: ['read'] },
	{
		includeBuiltins: true,
		tools: ['+powershell', '-bash'],
		expected: ['read', 'edit', 'write', 'powershell']
	}
])(
	'preserves Pi tool activation: $tools, builtins $includeBuiltins',
	async ({ includeBuiltins, tools, expected }) => {
		let extension: ExtensionAPI | undefined;

		await withPiRuntime(
			[
				{
					name: 'sandbox-tools',
					factory(pi) {
						extension = pi;
						sandboxTools(pi);
					}
				}
			],
			(_runtime, errors) => {
				if (extension === undefined) {
					throw new Error('The extension did not load.');
				}

				expect({ errors, active: extension.getActiveTools() }).toStrictEqual({
					errors: [],
					active: expected
				});

				return Promise.resolve();
			},
			{ includeBuiltins, ...(tools !== undefined && { tools }) }
		);
	}
);

it.each([
	{ isAllowed: true, isValid: true },
	{ isAllowed: false, isValid: true },
	{ isAllowed: true, isValid: false }
])(
	'retains nested Pi validation, approval and transforms: allowed $isAllowed, valid $isValid',
	async ({ isAllowed, isValid }) => {
		const { backend, requests } = shellBackend();
		const calls: { tool: string; parent: string | undefined }[] = [];
		const consumer: InlineExtension = {
			name: 'nested-consumer',
			factory(pi) {
				pi.registerTool({
					name: 'nested_shell',
					label: 'Nested shell',
					description: 'Call a shell through the Pi dispatcher.',
					parameters: createBashToolDefinition('/unused').parameters,
					async execute(_id, input, _signal, _update, context) {
						const outcome = await context.executeTool(
							'bash',
							isValid ? input : { command: { value: true } }
						);

						return {
							...outcome.result,
							details: undefined,
							isError: outcome.isError
						};
					}
				});
				pi.on('tool_call', (event) => {
					calls.push({ tool: event.toolName, parent: event.parentToolCallId });

					return !isAllowed && event.toolName === 'bash'
						? { block: true, reason: 'Nested approval denied.' }
						: undefined;
				});
				pi.on('tool_result', (event) =>
					event.toolName === 'bash'
						? { content: [{ type: 'text', text: 'transformed target output' }] }
						: undefined
				);
			}
		};
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'outer-call',
				name: 'nested_shell',
				arguments: { command: 'printf nested' }
			}
		]);

		await withPiRuntime(
			[
				provider(backend),
				{ name: 'sandbox-tools', factory: sandboxTools },
				consumer,
				model.extension
			],
			async (runtime, errors) => {
				runtime.session.setActiveToolsByName(['nested_shell', 'bash']);

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Use the nested shell.');

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						content: message.content,
						isError: message.isError,
						nested: message.nestedCalls?.calls.map((call) => ({
							name: call.name,
							status: call.status
						}))
					}));
				const expectedText: unknown = isValid
					? isAllowed
						? 'transformed target output'
						: 'Nested approval denied.'
					: expect.stringContaining('command');

				expect({ errors, calls, requests, results }).toStrictEqual({
					errors: [],
					calls: [
						{ tool: 'nested_shell', parent: undefined },
						...(isValid ? [{ tool: 'bash', parent: 'outer-call' }] : [])
					],
					requests:
						isAllowed && isValid
							? [
									{
										kind: 'shell',
										dialect: 'bash',
										command: 'printf nested',
										cwd: '/remote/project'
									}
								]
							: [],
					results: [
						{
							content: [
								{
									type: 'text',
									text: expectedText
								}
							],
							isError: !isAllowed || !isValid,
							nested: [
								{ name: 'bash', status: isAllowed && isValid ? 'ok' : 'error' }
							]
						}
					]
				});
			},
			{ prepare }
		);
	}
);

it('keeps Pi full-output storage and formatting for large target output', async () => {
	const output = Array.from(
		{ length: 4000 },
		(_, index) => `target row ${String(index)}`
	).join('\n');
	const { backend } = shellBackend(output);
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'large',
			name: 'bash',
			arguments: { command: 'large output' }
		}
	]);
	let result: ToolResultEvent | undefined;
	const observer: InlineExtension = {
		name: 'output-observer',
		factory(pi) {
			pi.on('tool_result', (event) => {
				result = event;
			});
		}
	};

	await withPiRuntime(
		[
			provider(backend),
			{ name: 'sandbox-tools', factory: sandboxTools },
			model.extension,
			observer
		],
		async (runtime, errors) => {
			runtime.session.setActiveToolsByName(['bash']);

			const selected = runtime.session.modelRuntime.getModel(
				'scripted',
				'scripted'
			);

			if (selected === undefined) {
				throw new Error('The scripted model was not registered.');
			}

			await runtime.session.setModel(selected);
			await runtime.session.prompt('Produce large output.');

			const structured = result?.structuredContent;
			const details = result?.details;

			if (!isRecord(details) || typeof details.fullOutputPath !== 'string') {
				throw new Error('Pi did not publish its full-output path.');
			}

			const filename = details.fullOutputPath;
			const contents = await readFile(filename, 'utf8');
			const measuredTime: unknown = expect.any(Number);
			const text = result?.content
				.filter((block) => block.type === 'text')
				.map((block) => block.text)
				.join('\n');

			expect({
				errors,
				isError: result?.isError,
				contents,
				structured,
				isWithinFixture:
					path.dirname(filename) === runtime.session.sessionManager.getCwd()
			}).toStrictEqual({
				errors: [],
				isError: false,
				contents: output,
				structured: {
					output,
					truncated: false,
					exit_code: 0,
					wall_time_seconds: measuredTime
				},
				isWithinFixture: true
			});
			expect(text).toContain(`Full output: ${filename}`);
			expect(Buffer.byteLength(text ?? '')).toBeLessThan(
				DEFAULT_MAX_BYTES + 1024
			);
		},
		{
			async prepare(directory, agentDirectory) {
				await prepare(directory, agentDirectory);
				vi.stubEnv('TMPDIR', directory);
			}
		}
	);
});

it('returns a selected-provider transport failure without local execution', async () => {
	const { backend, requests } = shellBackend();
	const failed: SandboxBackend = {
		...backend,
		exec(request) {
			requests.push(request);

			return Promise.reject(new SandboxTransportError({ operation: 'exec' }));
		}
	};
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'failure',
			name: 'bash',
			arguments: { command: 'must not run on host' }
		}
	]);

	await withPiRuntime(
		[
			provider(failed),
			{ name: 'sandbox-tools', factory: sandboxTools },
			model.extension
		],
		async (runtime, errors) => {
			runtime.session.setActiveToolsByName(['bash']);

			const selected = runtime.session.modelRuntime.getModel(
				'scripted',
				'scripted'
			);

			if (selected === undefined) {
				throw new Error('The scripted model was not registered.');
			}

			await runtime.session.setModel(selected);
			await runtime.session.prompt('Run the selected provider.');

			const results = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map((message) => ({
					content: message.content,
					isError: message.isError
				}));

			expect({ errors, requests, results }).toStrictEqual({
				errors: [],
				requests: [
					{
						kind: 'shell',
						dialect: 'bash',
						command: 'must not run on host',
						cwd: '/remote/project'
					}
				],
				results: [
					{
						content: [
							{
								type: 'text',
								text: 'The sandbox transport failed. Operation completion is unknown.'
							}
						],
						isError: true
					}
				]
			});
		},
		{ prepare }
	);
});

it('preserves the current Pi Bash command prefix through sandbox execution', async () => {
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'prefix',
			name: 'bash',
			arguments: { command: 'printf "%s" "${BYOS_PREFIX_TEST:-unset}"' }
		}
	]);

	await withPiRuntime(
		[{ name: 'shell', factory: sandboxTools }, model.extension],
		async (runtime, errors) => {
			runtime.services.settingsManager.setShellCommandPrefix(
				'export BYOS_PREFIX_TEST=present'
			);
			runtime.session.setActiveToolsByName(['bash']);

			const selected = runtime.session.modelRuntime.getModel(
				'scripted',
				'scripted'
			);

			if (selected === undefined) {
				throw new Error('The scripted model was not registered.');
			}

			await runtime.session.setModel(selected);
			await runtime.session.prompt('Check the configured environment.');

			const results = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map(({ content, isError }) => ({ content, isError }));

			expect({ errors, results }).toStrictEqual({
				errors: [],
				results: [
					{ content: [{ type: 'text', text: 'present' }], isError: false }
				]
			});
		},
		{
			prepare(_directory, agentDirectory) {
				vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
			}
		}
	);
});

it.each(['bash', 'powershell'])(
	'describes finite startup and execution defaults for %s',
	async (name) => {
		await withPiRuntime(
			[{ name: 'shell', factory: sandboxTools }],
			(runtime) => {
				const parameters: unknown = runtime.session
					.getAllTools()
					.find((tool) => tool.name === name)?.parameters;

				expect(parameters).toMatchObject({
					properties: {
						timeout: {
							description:
								'Timeout in seconds for startup and execution. If omitted, startup allows 60 seconds and execution 120 seconds.'
						}
					}
				});

				return Promise.resolve();
			}
		);
	}
);
