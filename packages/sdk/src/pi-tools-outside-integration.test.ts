import { readFile } from 'node:fs/promises';
import path from 'node:path';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { createBashTool } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import type { ExecutionApprovalRequest } from './approval-contracts.js';
import { approvalDecisionSchema } from './approval-schemas.js';
import type { SandboxConfig } from './config.js';
import { registerApprovalPolicy } from './execution-approval.js';
import { publishService } from './extension-services.js';
import { FixtureConfig } from './fixtures/config.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { initialiseSandboxHost } from './host.js';
import { outsideShellOperations } from './outside-shell-operations.js';
import sandboxTools from './pi-tools.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import { checker } from './schemas.js';

const isDecision = checker(approvalDecisionSchema);

it.each([
	{ kind: 'allow', dialect: 'bash', destination: 'normal' },
	{ kind: 'deny', dialect: 'bash', destination: 'normal' },
	{ kind: 'allow', dialect: 'bash', destination: 'provider' },
	{ kind: 'deny', dialect: 'bash', destination: 'provider' },
	{ kind: 'allow', dialect: 'powershell', destination: 'provider' },
	{ kind: 'deny', dialect: 'powershell', destination: 'provider' }
] as const)(
	'reviews $dialect execution on $destination through a separate scripted approver: $kind',
	async ({ kind, dialect, destination }) => {
		const reviewer = new ScriptedModel([], {
			providerId: 'approver',
			response: JSON.stringify({ kind })
		});
		const parent = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'outside',
				name: dialect,
				arguments: {
					command: 'printf outside',
					execution: 'outside-sandbox',
					justification: 'Print the fixture output.'
				}
			}
		]);
		const backend = shellBackend();
		const reviewed: ExecutionApprovalRequest[] = [];
		let ordinaryOpens = 0;

		let workspace = '';
		const config = new FixtureConfig();
		const extensions: InlineExtension[] = [
			{
				name: 'host',
				factory(pi) {
					initialiseSandboxHost(pi, {});
				}
			},
			{
				name: 'provider',
				factory(pi) {
					config.activate(pi, {
						id: 'fixture',
						label: 'Fixture sandbox',
						protocolVersion: 1,
						capabilities: backend.backend.capabilities,
						policies: {
							workspaceAccess: ['read-write'],
							filesystemScope: ['provider-default'],
							networkAccess: ['provider-default']
						},
						validateConfig: () => ({}),
						open() {
							ordinaryOpens++;

							return Promise.reject(
								new Error('The ordinary sandbox must not start.')
							);
						},
						outsideSandbox: {
							label: 'Fixture remote outside execution',
							capabilities: backend.backend.capabilities,
							policy: backend.backend.policy,
							open: () => Promise.resolve(backend.backend)
						}
					});
				}
			},
			reviewer.extension,
			{
				name: 'policy',
				factory(pi) {
					registerApprovalPolicy(pi, {
						id: 'scripted-review',
						label: 'Scripted reviewer',
						protocolVersion: 1,
						validateConfig: () => ({}),
						async decide(request, context) {
							reviewed.push(request);

							const model = context.pi.modelRegistry.find(
								'approver',
								'approver'
							);

							if (model === undefined) {
								throw new Error('The approver model was not registered.');
							}

							const result = await context.pi.modelRegistry
								.streamSimple(
									model,
									{
										messages: [
											{
												role: 'user',
												content: JSON.stringify(request),
												timestamp: 0
											}
										]
									},
									{ signal: context.signal }
								)
								.result();
							const text = result.content
								.filter((block) => block.type === 'text')
								.map((block) => block.text)
								.join('');
							const decision: unknown = JSON.parse(text);

							if (!isDecision(decision)) {
								throw new Error(
									'The scripted reviewer returned an invalid decision.'
								);
							}

							return decision;
						}
					});
				}
			},
			{ name: 'shell', factory: sandboxTools },
			parent.extension
		];

		await withPiRuntime(
			[
				...extensions,
				{
					name: 'execution-settings',
					factory: (pi) => {
						config.bind(pi);
					}
				}
			],
			async (runtime, errors) => {
				runtime.session.setActiveToolsByName([dialect]);

				const model = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (model === undefined) {
					throw new Error('The parent model was not registered.');
				}

				await runtime.session.setModel(model);
				await runtime.session.prompt(
					'Run the fixture command outside the sandbox.'
				);

				const results = parent.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map(({ isError, content }) => ({ isError, content }));

				expect({
					errors,
					ordinaryOpens,
					reviewed: reviewed.map(({ process, destination, justification }) => ({
						process,
						kind: destination.kind,
						relationship: destination.workspace.relationship,
						justification
					})),
					requests: backend.requests,
					results
				}).toStrictEqual({
					errors: [],
					ordinaryOpens: 0,
					reviewed: [
						{
							process: {
								kind: 'shell',
								dialect,
								command: 'printf outside',
								cwd: destination === 'normal' ? workspace : '/remote/project'
							},
							kind: destination,
							relationship: destination === 'normal' ? 'shared' : 'remote',
							justification: 'Print the fixture output.'
						}
					],
					requests:
						kind === 'allow' && destination === 'provider'
							? [
									{
										kind: 'shell',
										dialect,
										command: 'printf outside',
										cwd: '/remote/project'
									}
								]
							: [],
					results: [
						{
							isError: kind === 'deny',
							content: [
								{
									type: 'text',
									text:
										kind === 'deny'
											? 'Execution was denied by the selected approval policy.'
											: destination === 'normal'
												? 'outside'
												: 'target output'
								}
							]
						}
					]
				});
				expect(
					reviewer.requests.map((request) =>
						request.messages
							.filter((message) => message.role === 'user')
							.map((message) => message.content)
					)
				).toStrictEqual([[JSON.stringify(reviewed[0])]]);
			},
			{
				prepare: (directory_, _directory) => {
					workspace = directory_;
					config.set({
						provider: 'fixture',
						policy: backend.backend.policy,
						approval: { policy: 'scripted-review' },
						outsideSandbox: { destination }
					});
				}
			}
		);
	}
);

it('preserves native outside shell output on timeout', async () => {
	const config1 = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'timeout',
				factory(pi) {
					initialiseSandboxHost(pi, {});
					pi.registerCommand('timeout', {
						description: 'Exercise timeout output.',
						async handler(_arguments, context) {
							const tool = createBashTool(context.cwd, {
								operations: outsideShellOperations(
									pi,
									context,
									'bash',
									'Check timeout output.'
								)
							});

							vi.useFakeTimers();

							const outputReady = Promise.withResolvers<undefined>();
							const running = tool.execute(
								'timeout',
								{
									command: 'printf captured-output; sleep 30',
									timeout: 1
								},
								undefined,
								(update) => {
									if (
										update.content.some(
											(block) =>
												block.type === 'text' &&
												block.text.includes('captured-output')
										)
									) {
										outputReady.resolve(undefined);
									}
								}
							);
							const failed = expect(running).rejects.toThrow(
								'captured-output\n\nCommand timed out after 1 seconds'
							);

							try {
								await outputReady.promise;
								await vi.advanceTimersByTimeAsync(1000);
								await failed;
							} finally {
								vi.useRealTimers();
							}
						}
					});
				}
			},
			{
				name: 'execution-settings',
				factory: (pi) => {
					config1.bind(pi);
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/timeout');
			expect(errors).toStrictEqual([]);
		},
		{
			prepare: (_cwd, _agentDirectory) => {
				config1.set({ approval: { policy: 'always' } });
			}
		}
	);
});

afterEach(() => {
	vi.useRealTimers();
});

it('includes configuration loading in the outside shell deadline', async () => {
	let workspace = '';
	const started = Promise.withResolvers<undefined>();
	const config = Promise.withResolvers<SandboxConfig>();
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'deadline',
			name: 'bash',
			arguments: {
				command: 'printf late-output; printf dispatched > deadline-marker',
				execution: 'outside-sandbox',
				justification: 'Check the configuration deadline.',
				timeout: 0.05
			}
		}
	]);

	await withPiRuntime(
		[
			{
				name: 'delayed-settings',
				factory(pi) {
					const lifetime = new AbortController();
					const settings = {
						id: 'delayed-settings',
						diagnostics: new ProviderDiagnostics(),
						configurationVersion: 1 as const,
						guardVersion: 1 as const,
						assertConfigurable: vi.fn(),
						lifetime: lifetime.signal,
						close() {
							lifetime.abort();
						},
						read() {
							started.resolve(undefined);

							return config.promise;
						}
					};

					publishService(pi.events, 'pi-byos:settings:v1', settings);
				}
			},
			{ name: 'shell', factory: sandboxTools },
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
			vi.useFakeTimers();

			const running = runtime.session.prompt('Check the outside deadline.');

			await started.promise;
			await vi.advanceTimersByTimeAsync(100);
			config.resolve({
				selection: {
					providerId: 'passthrough',
					source: 'default',
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'provider-default'
					}
				},
				providerConfig: {},
				approval: { policy: 'always' }
			});
			await running;
			vi.useRealTimers();
			await expect(
				readFile(path.join(workspace, 'deadline-marker'))
			).rejects.toMatchObject({ code: 'ENOENT' });

			const results = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map(({ isError, content }) => ({ isError, content }));

			expect({ errors, results }).toStrictEqual({
				errors: [],
				results: [
					{
						isError: true,
						content: [
							{ type: 'text', text: 'Command timed out after 0.05 seconds' }
						]
					}
				]
			});
		},
		{
			prepare: (cwd) => {
				workspace = cwd;
			}
		}
	);
});
