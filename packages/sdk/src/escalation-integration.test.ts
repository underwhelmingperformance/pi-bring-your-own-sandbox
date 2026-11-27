import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { afterEach, expect, it, vi } from 'vitest';

import { ScriptedModel } from '../../../test-support/scripted-model.js';

import { createSandboxClient } from './client.js';
import type { PathGrants, ProcessRequest } from './contracts.js';
import {
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxStartupError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { EscalationRequest } from './escalation-ledger.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { registerFixtureProvider } from './fixtures/register-provider.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { resolveHostUserDataRoots } from './path-grants.js';
import sandboxTools from './pi-tools.js';
import { unrestrictedPolicy } from './policy-model.js';
import { createShellReviewClient } from './review.js';
import { isRecord } from './validation.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

it.each([
	{
		route: 'ordinary',
		behaviour: 'rejects an ordinary credential grant before allocation'
	},
	{
		route: 'reviewed',
		behaviour: 'grants a credential path after recording explicit approval'
	},
	{
		route: 'confirmation',
		behaviour:
			'shows the effective roots and permits only one-call credential approval'
	},
	{
		route: 'fallback',
		behaviour:
			'offers the unrestricted host when the provider cannot grant a credential'
	}
] as const)('$behaviour', async ({ route }) => {
	const temporaryHome = await mkdtemp(path.join(tmpdir(), 'byos-home-'));
	const home = await realpath(temporaryHome);
	const filename = '~/.ssh/id_ed25519';
	const hostPath = path.join(home, '.ssh/id_ed25519');
	const targetHome = '/fixture-home';
	const providerId = 'fixture.credentials';
	const { backend, requests } = shellBackend('target output', [
		path.posix.join(targetHome, '.ssh/id_ed25519')
	]);
	const isHostFallback = route === 'fallback';
	const profile = {
		...backend.profile,
		policy: { ...backend.profile.policy, hostUserData: 'read-only' as const },
		pathGrantKinds: ['read'] as const,
		...(!isHostFallback && { credentialPathGrantKinds: ['read'] as const })
	};
	const opened: { paths: PathGrants | undefined; ledger: unknown[] }[] = [];
	const refusals: unknown[] = [];
	const confirmations: {
		roots: boolean;
		unrestricted: boolean;
		choices: readonly string[];
	}[] = [];
	const command = 'printf fixture';
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'credential-call',
			name: 'bash',
			arguments: {
				command,
				escalate: [{ read: [filename] }],
				justification: 'Read synthetic credential data.'
			}
		}
	]);
	let readLedger: (() => unknown[]) | undefined;

	try {
		vi.stubEnv('HOME', home);

		const roots = await resolveHostUserDataRoots([home]);
		const scopeDescription = 'host user data roots ' + JSON.stringify(roots);

		await withPiRuntime(
			[
				{
					name: 'credential-provider',
					factory(pi) {
						registerFixtureProvider(
							pi,
							'<inline:credential-provider>',
							{
								id: providerId,
								label: 'Credential fixture',
								profiles: { open: [profile], copy: [] },
								validateConfig: () => ({}),
								open(request) {
									opened.push({
										paths: request.paths,
										ledger: readLedger?.() ?? []
									});

									return Promise.resolve({
										...backend,
										profile: request.profile,
										...(request.hostUserDataRoots !== undefined && {
											hostUserDataRoots: request.hostUserDataRoots
										}),
										workspace: {
											...backend.workspace,
											home: targetHome,
											hostUserDataRoot: home
										},
										grantedPaths: (request.paths?.read ?? []).map((grant) => ({
											kind: 'read' as const,
											hostPath: grant,
											targetPath: path.posix.join(
												targetHome,
												path.relative(home, grant)
											)
										}))
									});
								}
							},
							{
								configure: () => ({
									configuration: {},
									settings: {
										policy: profile.policy,
										allowEscalation: true,
										readRoots: [home]
									}
								}),
								persistReadRoot() {
									throw new Error(
										'Credential approvals must not reach the writer.'
									);
								}
							}
						);
					}
				},
				{
					name: 'sandbox-tools',
					factory(pi) {
						sandboxTools(pi, '<inline:sandbox-tools>');
					}
				},
				{
					name: 'credential-review',
					factory(pi) {
						if (route === 'ordinary') {
							const client = createSandboxClient(
								pi,
								'<inline:credential-review>'
							);

							pi.on('session_start', async (_event, context) => {
								try {
									await client.get(context, {
										access: { paths: { read: [filename] } }
									});
								} catch (error) {
									if (!isSandboxError(error, UnsupportedSandboxPolicyError)) {
										throw error;
									}

									refusals.push({ name: error.name, detail: error.detail });
								}
							});

							return;
						}

						if (route !== 'reviewed') {
							return;
						}

						const client = createShellReviewClient(
							pi,
							'<inline:credential-review>'
						);

						pi.on('tool_call', (event, context) => {
							const review = client.findShellReviewSource(context, event);
							const escalation = review.ok
								? review.source.escalation
								: undefined;

							if (escalation === undefined) {
								return;
							}

							expect({ opened, ledger: readLedger?.() }).toStrictEqual({
								opened: [],
								ledger: []
							});

							if (review.ok) {
								review.source.recordDecision?.('allow');
							}
						});
					}
				},
				model.extension
			],
			async (runtime, errors) => {
				if (route === 'ordinary') {
					expect({ errors, opened, refusals }).toStrictEqual({
						errors: [],
						opened: [],
						refusals: [
							{
								name: 'UnsupportedSandboxPolicyError',
								detail: {
									kind: 'path',
									access: 'read',
									path: hostPath,
									reason: 'limit'
								}
							}
						]
					});

					return;
				}

				readLedger = () =>
					runtime.session.sessionManager
						.getEntries()
						.flatMap((entry) =>
							entry.type === 'custom' && entry.customType === 'byos.ledger'
								? [entry.data]
								: []
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
				await runtime.session.prompt('Run the reviewed command.');

				const escalation = {
					kind: 'escalation',
					outcome: isHostFallback ? 'denied' : 'allowed',
					decider:
						route === 'reviewed'
							? {
									kind: 'permission-extension',
									extension: '<inline:credential-review>'
								}
							: { kind: 'confirmation' },
					request: {
						toolCallId: 'credential-call',
						command,
						justification: 'Read synthetic credential data.',
						access: { paths: { read: [hostPath] } },
						destination: isHostFallback
							? {
									kind: 'host',
									policy: unrestrictedPolicy,
									effectiveRestrictions: 'none'
								}
							: {
									kind: 'provider',
									providerId,
									policy: profile.policy,
									effectiveRestrictions: expect.stringContaining(
										scopeDescription
									) as unknown
								}
					}
				};

				expect({
					errors,
					opened,
					requests,
					confirmations,
					ledger: readLedger()
				}).toStrictEqual({
					errors: [],
					opened: isHostFallback
						? []
						: [{ paths: { read: [hostPath] }, ledger: [escalation] }],
					confirmations:
						route === 'confirmation' || isHostFallback
							? [
									{
										roots: !isHostFallback,
										unrestricted: isHostFallback,
										choices: ['Deny', 'Allow']
									}
								]
							: [],
					requests: isHostFallback
						? []
						: [
								{
									kind: 'shell',
									dialect: 'bash',
									command,
									cwd: backend.workspace.root
								}
							],
					ledger: [escalation]
				});
			},
			{
				select(text, choices) {
					confirmations.push({
						roots: text.includes(scopeDescription),
						unrestricted: text.includes('Effective restrictions: none'),
						choices
					});

					return Promise.resolve(isHostFallback ? 'Deny' : 'Allow');
				}
			}
		);
	} finally {
		await rm(home, { recursive: true, force: true });
	}
});

it.each([
	{
		tool: 'bash',
		decision: 'allow',
		allowedByConfig: true,
		runs: true,
		outcome: 'allowed'
	},
	{
		tool: 'powershell',
		decision: 'allow',
		allowedByConfig: true,
		runs: true,
		outcome: 'allowed'
	},
	{
		tool: 'bash',
		decision: 'deny',
		allowedByConfig: true,
		runs: false,
		outcome: 'denied'
	},
	{
		tool: 'bash',
		decision: 'allow',
		allowedByConfig: false,
		runs: false,
		outcome: 'denied'
	},
	{
		tool: 'bash',
		decision: 'conflict',
		allowedByConfig: true,
		runs: false,
		outcome: 'denied'
	},
	{
		tool: 'bash',
		decision: 'change-command',
		allowedByConfig: true,
		runs: false,
		outcome: 'cancelled'
	},
	{
		tool: 'bash',
		decision: 'fail-opening',
		allowedByConfig: true,
		runs: false,
		outcome: 'allowed'
	},
	{
		tool: 'bash',
		decision: 'unavailable-status',
		allowedByConfig: true,
		runs: true,
		outcome: 'allowed'
	}
] as const)(
	'records $outcome for $tool with permission $decision and escalation setting $allowedByConfig',
	async ({ tool, decision, allowedByConfig, runs, outcome }) => {
		const { backend } = shellBackend();
		const opens: boolean[] = [];
		const observed: EscalationRequest[] = [];
		const reviewSignals: AbortSignal[] = [];
		const requests: ProcessRequest[] = [];
		const decisionsAtOpen: unknown[][] = [];
		const prompts: string[] = [];
		let changeCommand: (() => void) | undefined;
		let readLedger: (() => unknown[]) | undefined;
		const ordinary = backend.profile;
		const isExitUnavailable = decision === 'unavailable-status';
		const elevated = {
			...ordinary,
			exitStatus: isExitUnavailable
				? ('optional' as const)
				: ordinary.exitStatus,
			policy: { ...ordinary.policy, network: true }
		};
		const provider: InlineExtension = {
			name: 'escalation-target',
			factory(pi) {
				registerFixtureProvider(
					pi,
					'<inline:escalation-target>',
					{
						id: 'fixture.escalation',
						label: 'Escalation fixture',
						profiles: { open: [ordinary, elevated], copy: [] },
						validateConfig: () => ({}),
						open(request) {
							opens.push(request.profile.policy.network);
							decisionsAtOpen.push(readLedger?.() ?? []);

							if (decision === 'fail-opening') {
								throw new SandboxStartupError({ operation: 'open' });
							}

							return Promise.resolve({
								...backend,
								profile: request.profile,
								async exec(command, context) {
									requests.push(command);

									const result = await backend.exec(command, context);

									return result.kind === 'exited'
										? {
												...result,
												exit: isExitUnavailable
													? { kind: 'unavailable' }
													: result.exit
											}
										: result;
								}
							});
						}
					},
					{
						configure: () => ({
							configuration: {},
							settings: {
								policy: ordinary.policy,
								allowEscalation: allowedByConfig
							}
						})
					}
				);
			}
		};
		const permission: InlineExtension = {
			name: 'escalation-permission',
			factory(pi) {
				const client = createShellReviewClient(
					pi,
					'<inline:escalation-permission>'
				);
				let record:
					| NonNullable<
							import('./contracts.js').ShellReviewSource['recordDecision']
					  >
					| undefined;

				pi.on('tool_call', (event, context) => {
					const review = client.findShellReviewSource(context, event);

					if (!review.ok || review.source.escalation === undefined) {
						return;
					}

					const { escalation, signal, recordDecision } = review.source;

					if (signal === undefined || recordDecision === undefined) {
						throw new Error(
							'The escalation review must supply a signal and decision method.'
						);
					}

					expect(signal.aborted).toBe(false);
					reviewSignals.push(signal);
					observed.push(escalation);
					record = recordDecision;

					const choice = decision === 'deny' ? 'deny' : 'allow';

					recordDecision(choice);
					recordDecision(choice);

					if (decision === 'conflict') {
						expect(() => {
							recordDecision('deny');
						}).toThrow(
							expect.objectContaining({
								name: InvalidSandboxRequestError.errorName,
								operation: 'exec'
							})
						);
					} else if (decision === 'change-command') {
						changeCommand?.();
					}
				});
				pi.on('tool_result', () => {
					if (record !== undefined) {
						expect(() => {
							record?.('allow');
						}).toThrow(
							expect.objectContaining({
								name: InvalidSandboxRequestError.errorName,
								operation: 'exec'
							})
						);
					}
				});
			}
		};
		const command = 'printf target';
		const justification = 'Fetch the example data.';
		const toolCallId = 'escalation-call';
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: toolCallId,
				name: tool,
				arguments: { command, escalate: ['network'], justification }
			}
		]);

		await withPiRuntime(
			[
				provider,
				{
					name: 'sandbox-tools',
					factory(pi) {
						sandboxTools(pi, '<inline:sandbox-tools>');
					}
				},
				permission,
				model.extension
			],
			async (runtime, errors) => {
				runtime.session.setActiveToolsByName([tool]);
				changeCommand = () => {
					runtime.services.settingsManager.setShellCommandPrefix(
						'printf changed'
					);
				};

				readLedger = () =>
					runtime.session.sessionManager
						.getEntries()
						.flatMap((entry) =>
							entry.type === 'custom' && entry.customType === 'byos.ledger'
								? [entry.data]
								: []
						);

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Run the shell tool.');

				const request = {
					toolCallId,
					command,
					justification,
					access: { network: 'needed' }
				};
				const destination = {
					kind: 'provider',
					providerId: 'fixture.escalation',
					policy: elevated.policy,
					effectiveRestrictions: expect.stringContaining(
						'host user data'
					) as unknown
				};
				const entries = readLedger();
				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						isError: message.isError,
						content: message.content
					}));
				const escalation = {
					kind: 'escalation',
					request: allowedByConfig ? { ...request, destination } : request,
					outcome,
					...(decision !== 'conflict' &&
						decision !== 'change-command' && {
							decider: allowedByConfig
								? {
										kind: 'permission-extension',
										extension: '<inline:escalation-permission>'
									}
								: { kind: 'configuration' }
						})
				};
				const isExpectedOpen = runs || decision === 'fail-opening';
				const errorContent: unknown = expect.any(Array);

				expect({
					errors,
					observed,
					reviewSignals: reviewSignals.map((signal) => signal.aborted),
					opens,
					requests,
					entries,
					results,
					decisionsAtOpen,
					prompts
				}).toStrictEqual({
					errors: [],
					prompts: [],
					observed: allowedByConfig ? [{ ...request, destination }] : [],
					reviewSignals: allowedByConfig ? [true] : [],
					opens: isExpectedOpen ? [true] : [],
					requests: runs
						? [
								{
									kind: 'shell',
									dialect: tool,
									command,
									cwd: '/remote/project'
								}
							]
						: [],
					entries: [escalation],
					results: [
						{
							isError: !runs || isExitUnavailable,
							content: runs
								? [
										{
											type: 'text',
											text: isExitUnavailable
												? 'target output\n\nCommand terminated without an exit code'
												: 'target output'
										},
										{
											type: 'text',
											text: 'Effective restrictions: Host workspace writes allowed, network allowed, host user data denied, host system files read-only'
										}
									]
								: errorContent
						}
					],
					decisionsAtOpen: isExpectedOpen ? [[escalation]] : []
				});
			},
			{
				prepare(_directory, agentDirectory) {
					vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
				},
				select(text) {
					prompts.push(text);

					return Promise.resolve(undefined);
				}
			}
		);
	}
);

it.each([
	{ answer: 'Allow', outcome: 'allowed', hasDecider: true, executes: true },
	{ answer: 'Deny', outcome: 'denied', hasDecider: true, executes: false },
	{
		answer: 'dismiss',
		outcome: 'cancelled',
		hasDecider: false,
		executes: false
	},
	{ answer: 'expire', outcome: 'expired', hasDecider: false, executes: false },
	{ answer: 'abort', outcome: 'cancelled', hasDecider: false, executes: false }
] as const)(
	'records $outcome for host confirmation answer $answer',
	async ({ answer, outcome, hasDecider, executes }) => {
		const toolCallId = 'host-call';
		const command = 'printf "%s" "$BYOS_ESCALATION_TEST"';
		const prefix = 'export BYOS_ESCALATION_TEST=confirmed';
		const justification = 'Read the fixture\u{1B}[31m path.';
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: toolCallId,
				name: 'bash',
				arguments: {
					command,
					escalate: ['network', { read: ['~'] }],
					justification
				}
			}
		]);
		const prompts: {
			readonly text: string;
			readonly choices: readonly string[];
		}[] = [];
		const home = await realpath(homedir());
		const { backend } = shellBackend();
		const opens: string[] = [];
		let abort: (() => void) | undefined;
		let restoreClock: (() => void) | undefined;

		try {
			await withPiRuntime(
				[
					{
						name: 'restricted-provider',
						factory(pi) {
							registerFixtureProvider(pi, '<inline:restricted-provider>', {
								id: 'fixture.restricted',
								label: 'Restricted fixture provider',
								profiles: { open: [backend.profile], copy: [] },
								validateConfig: () => ({}),
								open() {
									opens.push('provider');

									return Promise.resolve(backend);
								}
							});
						}
					},
					{
						name: 'sandbox-tools',
						factory(pi) {
							sandboxTools(pi, '<inline:sandbox-tools>');
						}
					},
					model.extension
				],
				async (runtime, errors) => {
					runtime.services.settingsManager.setShellCommandPrefix(prefix);
					runtime.session.setActiveToolsByName(['bash']);
					abort = () => {
						runtime.session.agent.abort();
					};

					const selected = runtime.session.modelRuntime.getModel(
						'scripted',
						'scripted'
					);

					if (selected === undefined) {
						throw new Error('The scripted model was not registered.');
					}

					await runtime.session.setModel(selected);
					await runtime.session.prompt('Run the reviewed command.');

					const entries = runtime.session.sessionManager
						.getEntries()
						.flatMap((entry) =>
							entry.type === 'custom' && entry.customType === 'byos.ledger'
								? [entry.data]
								: []
						);
					const results = model.requests
						.at(1)
						?.messages.filter((message) => message.role === 'toolResult');
					const isRan =
						results?.some(
							(result) =>
								!result.isError &&
								result.content.some(
									(block) => block.type === 'text' && block.text === 'confirmed'
								)
						) ?? false;
					const access = { network: 'needed', paths: { read: [home] } };
					const text = [
						'Allow sandbox escalation?',
						String.raw`Command: ${prefix}\x0a${command}`,
						String.raw`Justification: Read the fixture\x1b[31m path.`,
						'Requested access: ' + JSON.stringify(access),
						'Destination: Host execution without isolation',
						'Effective restrictions: none'
					].join('\n');

					expect({ errors, prompts, entries, ran: isRan, opens }).toStrictEqual(
						{
							errors: [],
							opens: [],
							prompts: [{ text, choices: ['Deny', 'Allow'] }],
							entries: [
								{
									kind: 'escalation',
									request: {
										toolCallId,
										command: prefix + '\n' + command,
										justification,
										access,
										destination: {
											kind: 'host',
											policy: unrestrictedPolicy,
											effectiveRestrictions: 'none'
										}
									},
									outcome,
									...(hasDecider && { decider: { kind: 'confirmation' } })
								}
							],
							ran: executes
						}
					);
				},
				{
					prepare(_directory, agentDirectory) {
						vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
					},
					select(text, choices) {
						prompts.push({ text, choices });

						if (answer === 'expire') {
							const elapsed = performance.now() + 61_000;
							const clock = vi
								.spyOn(performance, 'now')
								.mockReturnValue(elapsed);

							restoreClock = () => {
								clock.mockRestore();
							};

							return Promise.resolve('Allow');
						}

						if (answer === 'abort') {
							abort?.();
						}

						return Promise.resolve(
							answer === 'Allow' || answer === 'Deny' ? answer : undefined
						);
					}
				}
			);
		} finally {
			restoreClock?.();
		}
	}
);

it.each([
	{ selection: 'Allow', expectedPrompts: 2 },
	{ selection: 'Allow for session', expectedPrompts: 1 }
])(
	'reuses a read approval for the chosen duration: $selection',
	async ({ selection, expectedPrompts }) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'byos-read-grant-'));

		try {
			const root = await realpath(directory);
			const file = path.join(root, 'document.txt');
			const { backend, requests } = shellBackend('target output', [file]);
			const profile = { ...backend.profile, pathGrantKinds: ['read'] as const };
			const prompts: string[][] = [];
			const resultErrors: boolean[] = [];
			const model = new ScriptedModel([
				{
					type: 'toolCall',
					name: 'run_twice',
					id: 'repeat-read',
					arguments: {}
				}
			]);

			await withPiRuntime(
				[
					{
						name: 'read-provider',
						factory(pi) {
							registerFixtureProvider(pi, '<inline:read-provider>', {
								id: 'fixture.reader',
								label: 'Read fixture',
								profiles: { open: [profile], copy: [] },
								validateConfig: () => ({}),
								open(request) {
									return Promise.resolve({
										...backend,
										profile: request.profile,
										grantedPaths: (request.paths?.read ?? []).map(
											(granted) => ({
												kind: 'read' as const,
												hostPath: granted,
												targetPath: granted
											})
										)
									});
								}
							});
						}
					},
					{
						name: 'sandbox-tools',
						factory(pi) {
							sandboxTools(pi, '<inline:sandbox-tools>');
						}
					},
					{
						name: 'run-twice',
						factory(pi) {
							pi.registerTool({
								name: 'run_twice',
								label: 'Run twice',
								description: 'Request the same read grant twice in order.',
								parameters: Type.Object({}),
								async execute(_id, _input, _signal, _update, context) {
									for (const command of ['read once', 'read again']) {
										const result = await context.executeTool('bash', {
											command,
											escalate: [{ read: [file] }],
											justification: 'Read the fixture.'
										});

										resultErrors.push(result.isError);
									}

									return {
										content: [{ type: 'text', text: 'Finished.' }],
										details: {}
									};
								}
							});
						}
					},
					model.extension
				],
				async (runtime, errors) => {
					const chosen = runtime.session.modelRuntime.getModel(
						'scripted',
						'scripted'
					);

					if (chosen === undefined) {
						throw new Error('The scripted model was not registered.');
					}

					await runtime.session.setModel(chosen);
					runtime.session.setActiveToolsByName(['bash', 'run_twice']);
					await runtime.session.prompt('Run both read requests.');

					const deciders = runtime.session.sessionManager
						.getEntries()
						.flatMap((entry) => {
							return entry.type === 'custom' &&
								entry.customType === 'byos.ledger' &&
								isRecord(entry.data) &&
								entry.data['kind'] === 'escalation'
								? [entry.data['decider']]
								: [];
						});

					expect({
						errors,
						prompts,
						resultErrors,
						deciders,
						commands: requests.map((request) =>
							request.kind === 'shell' ? request.command : undefined
						)
					}).toStrictEqual({
						errors: [],
						prompts: Array.from({ length: expectedPrompts }, () => [
							'Deny',
							'Allow',
							'Allow for session'
						]),
						resultErrors: [false, false],
						deciders: [
							{ kind: 'confirmation' },
							selection === 'Allow'
								? { kind: 'confirmation' }
								: { kind: 'remembered-read', toolCallIds: ['repeat-read/1'] }
						],
						commands: ['read once', 'read again']
					});
				},
				{
					select(_text, choices) {
						prompts.push([...choices]);

						return Promise.resolve(
							choices.find((choice) => choice === selection)
						);
					}
				}
			);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
