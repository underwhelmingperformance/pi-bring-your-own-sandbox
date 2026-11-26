import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
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
import { shellBackend } from './fixtures/shell-backend.js';
import sandboxTools from './pi-tools.js';
import { unrestrictedPolicy } from './policy-model.js';
import { registerSandboxProvider } from './provider-registration.js';

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
	}
] as const)('$behaviour', async ({ route }) => {
	const temporaryHome = await mkdtemp(path.join(tmpdir(), 'byos-home-'));
	const home = await realpath(temporaryHome);
	const filename = '~/.ssh/id_ed25519';
	const hostPath = path.join(home, '.ssh/id_ed25519');
	const targetHome = '/fixture-home';
	const providerId = 'fixture.credentials';
	const { backend, requests } = shellBackend();
	const profile = {
		...backend.profile,
		policy: { ...backend.profile.policy, hostUserData: 'read-only' as const },
		pathGrantKinds: ['read'] as const
	};
	const opened: { paths: PathGrants | undefined; ledger: unknown[] }[] = [];
	const refusals: unknown[] = [];
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
		await withPiRuntime(
			[
				{
					name: 'credential-provider',
					factory(pi) {
						registerSandboxProvider(
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
									settings: { policy: profile.policy, allowEscalation: true }
								})
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
						const client = createSandboxClient(
							pi,
							'<inline:credential-review>'
						);

						if (route === 'ordinary') {
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
							client.recordEscalationDecision(context, escalation, 'allow');
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
					outcome: 'allowed',
					decider: {
						kind: 'permission-extension',
						extension: '<inline:credential-review>'
					},
					request: {
						toolCallId: 'credential-call',
						command,
						justification: 'Read synthetic credential data.',
						access: { paths: { read: [hostPath] } },
						destination: {
							kind: 'provider',
							providerId,
							policy: profile.policy,
							effectiveRestrictions: expect.stringContaining(
								'host user data read-only'
							) as unknown
						}
					}
				};

				expect({
					errors,
					opened,
					requests,
					ledger: readLedger()
				}).toStrictEqual({
					errors: [],
					opened: [{ paths: { read: [hostPath] }, ledger: [escalation] }],
					requests: [
						{
							kind: 'shell',
							dialect: 'bash',
							command,
							cwd: backend.workspace.root
						}
					],
					ledger: [escalation]
				});
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
		const requests: ProcessRequest[] = [];
		const operationIds: string[] = [];
		const decisionsAtOpen: unknown[][] = [];
		const prompts: string[] = [];
		const violation = {
			operation: 'open\u{1B}[31m',
			accessProperty: 'hostUserData',
			resource: '/data'
		} as const;
		let changeCommand: (() => void) | undefined;
		let readLedger: (() => unknown[]) | undefined;
		const ordinary = backend.profile;
		const isExitUnavailable = decision === 'unavailable-status';
		const elevated = {
			...ordinary,
			exitStatus: isExitUnavailable
				? ('optional' as const)
				: ordinary.exitStatus,
			capabilities: [...ordinary.capabilities, 'violations' as const],
			policy: { ...ordinary.policy, network: true }
		};
		const provider: InlineExtension = {
			name: 'escalation-target',
			factory(pi) {
				registerSandboxProvider(
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
									operationIds.push(context.operationId);

									const result = await backend.exec(command, context);

									return result.kind === 'exited'
										? {
												...result,
												exit: isExitUnavailable
													? { kind: 'unavailable' }
													: result.exit,
												violations: [violation]
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
				const client = createSandboxClient(
					pi,
					'<inline:escalation-permission>'
				);

				pi.on('tool_call', (event, context) => {
					const review = client.findShellReviewSource(context, event);
					const request = review.ok ? review.source.escalation : undefined;

					if (request === undefined) {
						return;
					}

					observed.push(request);
					client.recordEscalationDecision(
						context,
						request,
						decision === 'deny' ? 'deny' : 'allow'
					);

					if (decision === 'conflict') {
						expect(() => {
							client.recordEscalationDecision(context, request, 'deny');
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
				pi.on('tool_result', (_event, context) => {
					const [request] = observed;

					if (request !== undefined) {
						expect(() => {
							client.recordEscalationDecision(context, request, 'allow');
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
					entries: [
						escalation,
						...(runs
							? [
									{
										kind: 'violation',
										operationId: operationIds[0],
										toolCallId,
										providerId: 'fixture.escalation',
										violations: [violation]
									}
								]
							: [])
					],
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
										},
										{
											type: 'text',
											text: String.raw`Restriction violation: open\x1b[31m (hostUserData) on /data`
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
							registerSandboxProvider(pi, '<inline:restricted-provider>', {
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
