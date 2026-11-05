import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { RpcExtensionUIRequest } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { RpcProcess } from './fixtures/rpc-process.js';
import { observe } from './lifecycle.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

const isConfirmation = checker(
	Type.Object({
		type: Type.Literal('extension_ui_request'),
		id: Type.String(),
		method: Type.Literal('confirm'),
		title: Type.String(),
		message: Type.String(),
		timeout: Type.Number({ exclusiveMinimum: 0 })
	})
);

type Confirmation = Extract<RpcExtensionUIRequest, { method: 'confirm' }>;
interface Fixture {
	readonly rpc: RpcProcess;
	readonly directory: string;
	readonly effects: () => Promise<string>;
	readonly records: () => Promise<unknown[]>;
}
interface Options {
	readonly destination?: 'normal' | 'provider';
	readonly mode?: 'sdk' | 'bash' | 'powershell';
	readonly timeoutMs?: number;
	readonly config?: unknown;
	readonly failure?: 'open' | 'exec';
	readonly projectConfig?: unknown;
	readonly shellCommandPrefix?: string;
	readonly arguments?: Readonly<Record<string, string | number>>;
}

async function fixture(
	run: (fixture: Fixture) => Promise<void>,
	options: Options = {}
): Promise<void> {
	const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-approval-rpc-'));
	const directory = await realpath(temporary);

	try {
		await mkdir(path.join(directory, 'agent'));
		await writeFile(
			path.join(directory, 'fixture.json'),
			JSON.stringify({
				mode: options.mode ?? 'sdk',
				timeoutMs: options.timeoutMs ?? 30_000,
				...(options.failure !== undefined && { failure: options.failure }),
				...(options.arguments !== undefined && { arguments: options.arguments })
			})
		);
		await writeFile(
			path.join(directory, 'agent/approval-settings.json'),
			JSON.stringify(
				options.config ?? {
					provider: 'rpc-provider',
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'provider-default'
					},
					outsideSandbox: { destination: options.destination ?? 'provider' }
				}
			)
		);

		if (options.projectConfig !== undefined) {
			await mkdir(path.join(directory, '.pi'));
			await writeFile(
				path.join(directory, '.pi/byos.json'),
				JSON.stringify(options.projectConfig)
			);
		}

		if (options.shellCommandPrefix !== undefined) {
			await writeFile(
				path.join(directory, 'agent/settings.json'),
				JSON.stringify({ shellCommandPrefix: options.shellCommandPrefix })
			);
		}

		const entry = fileURLToPath(
			import.meta.resolve('@earendil-works/pi-coding-agent')
		);
		const rpc = new RpcProcess(
			path.join(path.dirname(entry), 'bundle/cli.js'),
			directory,
			fileURLToPath(
				new URL('fixtures/approval-rpc-extension.ts', import.meta.url)
			)
		);
		const contents = async (filename: string) => {
			try {
				return await readFile(path.join(directory, filename), 'utf8');
			} catch (error) {
				if (isRecord(error) && error.code === 'ENOENT') {
					return '';
				}

				throw error;
			}
		};

		try {
			await rpc.send({ type: 'get_state' });
			await run({
				rpc,
				directory,
				effects: () => contents('executions'),
				records: async () => {
					const records = await contents('journal.jsonl');

					return records.trim() === ''
						? []
						: records
								.trim()
								.split('\n')
								.map((line): unknown => JSON.parse(line));
				}
			});
		} finally {
			await rpc.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function confirmation(rpc: RpcProcess): Promise<Confirmation> {
	const event = await rpc.waitForEvent((event) => isConfirmation(event));

	if (!isConfirmation(event)) {
		throw new Error('Pi did not emit a valid confirmation request.');
	}

	return event;
}

it.each([
	{ destination: 'normal', response: { confirmed: true }, allowed: true },
	{ destination: 'normal', response: { confirmed: false }, allowed: false },
	{ destination: 'provider', response: { confirmed: true }, allowed: true },
	{ destination: 'provider', response: { confirmed: false }, allowed: false },
	{ destination: 'provider', response: { cancelled: true }, allowed: false }
] as const)(
	'uses real RPC user confirmation on $destination: $response',
	async ({ destination, response, allowed }) => {
		await fixture(
			async ({ rpc, effects, records, directory }) => {
				const requested = confirmation(rpc);
				const running = observe(
					rpc.send({ type: 'prompt', message: '/fixture-sdk' })
				);
				const request = await requested;

				expect(await effects()).toBe('');
				expect({
					...request,
					id: '<id>',
					timeout: '<budget>',
					message: request.message
						.replace(process.execPath, '<node>')
						.replace(directory, '<workspace>')
				}).toStrictEqual({
					type: 'extension_ui_request',
					id: '<id>',
					method: 'confirm',
					title: 'Approve process execution?',
					timeout: '<budget>',
					message: `${destination === 'provider' ? 'RPC outside destination\nOutside execution in a fake remote environment.\nWorking directory: /rpc/target' : 'Host execution without isolation\nProcesses use the host filesystem, network and inherited environment. No sandbox isolation is applied.\nWorking directory: <workspace>'}\nEnvironment overrides: VISIBLE_OVERRIDE\n\n${JSON.stringify(['<node>', '-e', 'require("node:fs").appendFileSync("executions", "normal\\n"); process.stdout.write("approved")'])}\n\nExercise user approval through RPC.`
				});
				rpc.respond({
					type: 'extension_ui_response',
					id: request.id,
					...response
				});
				await running;

				const journal = await records();

				expect(
					journal.filter(
						(record) =>
							isRecord(record) &&
							['ordinary-open', 'outside-open'].includes(String(record.kind))
					)
				).toStrictEqual(
					destination === 'provider' ? [{ kind: 'outside-open' }] : []
				);

				expect({
					effects: await effects(),
					result: journal.filter(
						(record) =>
							isRecord(record) &&
							['result', 'error'].includes(String(record.kind))
					)
				}).toStrictEqual({
					effects: allowed ? `${destination}\n` : '',
					result: [
						allowed
							? {
									kind: 'result',
									exit: { kind: 'code', code: 0 },
									stdout: 'approved'
								}
							: { kind: 'error', name: 'ApprovalDeniedError' }
					]
				});
			},
			{ destination }
		);
	},
	20_000
);

it('ignores an expired RPC response and asks again for the next invocation', async () => {
	await fixture(
		async ({ rpc, effects, records }) => {
			const requested = confirmation(rpc);
			const first = observe(
				rpc.send({ type: 'prompt', message: '/fixture-sdk' })
			);
			const expired = await requested;

			await first;
			rpc.respond({
				type: 'extension_ui_response',
				id: expired.id,
				confirmed: true
			});

			const next = confirmation(rpc);
			const second = observe(
				rpc.send({ type: 'prompt', message: '/fixture-sdk' })
			);
			const current = await next;

			expect({
				effects: await effects(),
				differentRequest: expired.id !== current.id
			}).toStrictEqual({ effects: '', differentRequest: true });
			rpc.respond({
				type: 'extension_ui_response',
				id: current.id,
				confirmed: true
			});
			await second;

			const journal = await records();
			const outcomes = journal.filter(
				(record) =>
					isRecord(record) &&
					(record.kind === 'error' || record.kind === 'result')
			);
			const [expiredOutcome, ...laterOutcomes] = outcomes;

			expect([
				{ kind: 'error', name: 'ApprovalDeniedError' },
				{
					kind: 'error',
					name: 'SandboxTimeoutError',
					reason: 'deadline',
					completion: 'not-started'
				}
			]).toContainEqual(expiredOutcome);
			expect({
				effects: await effects(),
				outcomes: laterOutcomes
			}).toStrictEqual({
				effects: 'provider\n',
				outcomes: [
					{
						kind: 'result',
						exit: { kind: 'code', code: 0 },
						stdout: 'approved'
					}
				]
			});
		},
		{ timeoutMs: 1000 }
	);
}, 20_000);

it('expires a queued request without displaying a second RPC dialogue', async () => {
	await fixture(async ({ rpc, effects, records }) => {
		const requested = confirmation(rpc);
		const first = observe(
			rpc.send({ type: 'prompt', message: '/fixture-sdk' })
		);
		const request = await requested;

		await rpc.send({ type: 'prompt', message: '/fixture-sdk short' });
		expect({
			effects: await effects(),
			confirmations: rpc.events
				.filter((event) => isConfirmation(event))
				.map(({ id }) => id)
		}).toStrictEqual({ effects: '', confirmations: [request.id] });
		rpc.respond({
			type: 'extension_ui_response',
			id: request.id,
			confirmed: true
		});
		await first;

		const journal = await records();

		expect({
			effects: await effects(),
			outcomes: journal.filter(
				(record) =>
					isRecord(record) && ['error', 'result'].includes(String(record.kind))
			)
		}).toStrictEqual({
			effects: 'provider\n',
			outcomes: [
				{
					kind: 'error',
					name: 'SandboxTimeoutError',
					reason: 'deadline',
					completion: 'not-started'
				},
				{ kind: 'result', exit: { kind: 'code', code: 0 }, stdout: 'approved' }
			]
		});
	});
}, 20_000);

it.each(['fixture-cancel', 'fixture-close', 'session_shutdown'] as const)(
	'cancels a pending real RPC confirmation on %s',
	async (action) => {
		await fixture(async ({ rpc, effects, records }) => {
			const requested = confirmation(rpc);
			const running = observe(
				rpc.send({ type: 'prompt', message: '/fixture-sdk' })
			);
			const request = await requested;

			if (action === 'session_shutdown') {
				await rpc.close();
			} else {
				await rpc.send({ type: 'prompt', message: `/${action}` });
				rpc.respond({
					type: 'extension_ui_response',
					id: request.id,
					confirmed: true
				});
			}

			await running;

			const journal = await records();

			expect({
				effects: await effects(),
				outcomes: journal.filter(
					(record) => isRecord(record) && record.kind === 'error'
				)
			}).toStrictEqual({
				effects: '',
				outcomes: [
					{
						kind: 'error',
						name: 'SandboxCancelledError',
						reason: action === 'fixture-cancel' ? 'caller' : 'shutdown',
						completion: 'not-started'
					}
				]
			});
		});
	},
	20_000
);

async function toolResult(rpc: RpcProcess) {
	const event = await rpc.waitForEvent(
		(event) => isRecord(event) && event.type === 'tool_execution_end'
	);

	if (!isRecord(event) || !isRecord(event.result)) {
		throw new Error('Pi did not emit a tool result.');
	}

	return {
		tool: event.toolName,
		content: event.result.content,
		isError: event.isError
	};
}

it.each([
	{ destination: 'normal', mode: 'bash', decision: 'allow' },
	{ destination: 'normal', mode: 'bash', decision: 'deny' },
	{ destination: 'provider', mode: 'bash', decision: 'allow' },
	{ destination: 'provider', mode: 'bash', decision: 'abort' },
	{ destination: 'provider', mode: 'powershell', decision: 'allow' },
	{ destination: 'provider', mode: 'powershell', decision: 'dismiss' }
] as const)(
	'runs the $mode tool on $destination with RPC user decision $decision',
	async ({ destination, mode, decision }) => {
		await fixture(
			async ({ rpc, effects }) => {
				await rpc.send({
					type: 'set_model',
					provider: 'scripted',
					modelId: 'scripted'
				});

				const requested = confirmation(rpc);
				const completed = toolResult(rpc);

				await rpc.send({ type: 'prompt', message: 'Run the fixture tool.' });

				const request = await requested;

				expect(await effects()).toBe('');

				if (decision === 'abort') {
					await rpc.send({ type: 'abort' });
					rpc.respond({
						type: 'extension_ui_response',
						id: request.id,
						confirmed: true
					});
				} else {
					rpc.respond({
						type: 'extension_ui_response',
						id: request.id,
						...(decision === 'dismiss'
							? { cancelled: true }
							: { confirmed: decision === 'allow' })
					});
				}

				expect({
					result: await completed,
					effects: await effects()
				}).toStrictEqual({
					result: {
						tool: mode,
						content: [
							{
								type: 'text',
								text:
									decision === 'allow'
										? 'approved'
										: decision === 'abort'
											? 'Command aborted'
											: 'Execution was denied by the selected approval policy.'
							}
						],
						isError: decision !== 'allow'
					},
					effects: decision === 'allow' ? `${destination}\n` : ''
				});
			},
			{ destination, mode }
		);
	},
	20_000
);

it.each([true, false])(
	'requires a fresh user confirmation after decision %s',
	async (isAllowed) => {
		await fixture(async ({ rpc, effects }) => {
			const requested = confirmation(rpc);
			const first = observe(
				rpc.send({ type: 'prompt', message: '/fixture-sdk' })
			);
			const firstConfirmation = await requested;

			rpc.respond({
				type: 'extension_ui_response',
				id: firstConfirmation.id,
				confirmed: isAllowed
			});
			await first;

			const next = confirmation(rpc);
			const second = observe(
				rpc.send({ type: 'prompt', message: '/fixture-sdk' })
			);
			const secondConfirmation = await next;

			expect({
				effects: await effects(),
				differentRequest: firstConfirmation.id !== secondConfirmation.id
			}).toStrictEqual({
				effects: isAllowed ? 'provider\n' : '',
				differentRequest: true
			});
			rpc.respond({
				type: 'extension_ui_response',
				id: secondConfirmation.id,
				confirmed: !isAllowed
			});
			await second;
			expect(await effects()).toBe('provider\n');
		});
	},
	20_000
);

it('invalidates pending user approval when RPC replaces the session', async () => {
	await fixture(async ({ rpc, effects, records }) => {
		const requested = confirmation(rpc);
		const first = observe(
			rpc.send({ type: 'prompt', message: '/fixture-sdk' })
		);
		const obsolete = await requested;

		await rpc.send({ type: 'new_session' });
		await first;
		rpc.respond({
			type: 'extension_ui_response',
			id: obsolete.id,
			confirmed: true
		});

		const next = confirmation(rpc);
		const second = observe(
			rpc.send({ type: 'prompt', message: '/fixture-sdk' })
		);
		const current = await next;

		expect(await effects()).toBe('');
		rpc.respond({
			type: 'extension_ui_response',
			id: current.id,
			confirmed: false
		});
		await second;

		const journal = await records();

		expect({
			effects: await effects(),
			outcomes: journal.filter(
				(record) => isRecord(record) && record.kind === 'error'
			)
		}).toStrictEqual({
			effects: '',
			outcomes: [
				{
					kind: 'error',
					name: 'SandboxCancelledError',
					reason: 'shutdown',
					completion: 'not-started'
				},
				{ kind: 'error', name: 'ApprovalDeniedError' }
			]
		});
	});
}, 20_000);

it.each([
	{
		policy: 'always',
		config: {},
		outcome: {
			kind: 'result',
			exit: { kind: 'code', code: 0 },
			stdout: 'approved'
		},
		effects: 'provider\n'
	},
	{
		policy: 'never',
		config: {},
		outcome: { kind: 'error', name: 'ApprovalDeniedError' },
		effects: ''
	},
	{
		policy: 'missing',
		config: {},
		outcome: { kind: 'error', name: 'ApprovalPolicyNotFoundError' },
		effects: ''
	},
	{
		policy: 'always',
		config: { unexpected: true },
		outcome: { kind: 'error', name: 'ApprovalPolicyError' },
		effects: ''
	},
	{
		policy: 'rpc-failure',
		config: {},
		outcome: { kind: 'error', name: 'ApprovalPolicyError' },
		effects: ''
	}
] as const)(
	'applies personally selected RPC approval policy $policy with $config',
	async ({ policy, config, outcome, effects: expectedEffects }) => {
		await fixture(
			async ({ rpc, effects, records }) => {
				await rpc.send({ type: 'prompt', message: '/fixture-sdk' });

				const journal = await records();

				expect({
					effects: await effects(),
					outcomes: journal.filter(
						(record) =>
							isRecord(record) &&
							['error', 'result'].includes(String(record.kind))
					),
					confirmations: rpc.events.filter((event) => isConfirmation(event))
				}).toStrictEqual({
					effects: expectedEffects,
					outcomes: [outcome],
					confirmations: []
				});
			},
			{
				config: {
					provider: 'rpc-provider',
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'provider-default'
					},
					outsideSandbox: { destination: 'provider' },
					approval: { policy, config }
				}
			}
		);
	},
	20_000
);

it.each([
	{ failure: 'open', error: 'SandboxStartupError' },
	{ failure: 'exec', error: 'SandboxTransportError' }
] as const)(
	'reports an outside provider $failure failure without normal execution',
	async ({ failure, error }) => {
		await fixture(
			async ({ rpc, effects, records }) => {
				const requested = failure === 'exec' ? confirmation(rpc) : undefined;
				const running = observe(
					rpc.send({ type: 'prompt', message: '/fixture-sdk' })
				);

				if (requested !== undefined) {
					const request = await requested;

					rpc.respond({
						type: 'extension_ui_response',
						id: request.id,
						confirmed: true
					});
				}

				await running;

				const journal = await records();

				expect({
					effects: await effects(),
					outcomes: journal.filter(
						(record) => isRecord(record) && record.kind === 'error'
					)
				}).toStrictEqual({
					effects: '',
					outcomes: [
						{
							kind: 'error',
							name: error,
							...(failure === 'exec' && { completion: 'unknown' })
						}
					]
				});
			},
			{ failure }
		);
	},
	20_000
);

it.each([
	{ command: 'printf forbidden', execution: 'outside-sandbox' },
	{
		command: 'printf forbidden',
		justification: 'Unexpected on the ordinary route.'
	}
])(
	'rejects inconsistent shell execution arguments $execution',
	async (arguments_) => {
		await fixture(
			async ({ rpc, effects }) => {
				await rpc.send({
					type: 'set_model',
					provider: 'scripted',
					modelId: 'scripted'
				});

				const completed = toolResult(rpc);

				await rpc.send({
					type: 'prompt',
					message: 'Run the invalid fixture tool.'
				});
				expect({
					result: await completed,
					effects: await effects(),
					confirmations: rpc.events.filter((event) => isConfirmation(event))
				}).toStrictEqual({
					result: {
						tool: 'bash',
						content: [
							{
								type: 'text',
								text: 'Provide a valid execution destination, process and non-empty justification.'
							}
						],
						isError: true
					},
					effects: '',
					confirmations: []
				});
			},
			{ mode: 'bash', arguments: arguments_ }
		);
	},
	20_000
);

it('ignores project provider and approval settings in a live RPC session', async () => {
	await fixture(
		async ({ rpc, effects, records }) => {
			const requested = confirmation(rpc);
			const running = observe(
				rpc.send({ type: 'prompt', message: '/fixture-sdk' })
			);
			const request = await requested;

			rpc.respond({
				type: 'extension_ui_response',
				id: request.id,
				confirmed: false
			});
			await running;

			expect({
				effects: await effects(),
				records: await records()
			}).toStrictEqual({
				effects: '',
				records: [
					{ kind: 'outside-open' },
					{ kind: 'error', name: 'ApprovalDeniedError' }
				]
			});
		},
		{
			projectConfig: {
				provider: 'passthrough',
				approval: { policy: 'always' },
				outsideSandbox: { destination: 'normal' }
			}
		}
	);
}, 20_000);

async function diagnosticMessages(rpc: RpcProcess): Promise<string[]> {
	const response = await rpc.send({ type: 'get_messages' });

	if (
		!isRecord(response) ||
		!isRecord(response.data) ||
		!Array.isArray(response.data.messages)
	) {
		throw new Error('Pi did not return a message list.');
	}

	const messages: unknown[] = response.data.messages;

	const contents: string[] = [];

	for (const message of messages) {
		if (
			!isRecord(message) ||
			message.role !== 'custom' ||
			message.customType !== 'byos' ||
			typeof message.content !== 'string'
		) {
			continue;
		}

		contents.push(message.content);
	}

	return contents;
}

it('reports selected and unavailable approval policies through RPC without allocation', async () => {
	await fixture(
		async ({ rpc, records }) => {
			await rpc.send({ type: 'prompt', message: '/byos status' });
			await rpc.send({ type: 'prompt', message: '/byos approval-policies' });

			const messages = await diagnosticMessages(rpc);

			expect({
				settings: messages[0]
					?.split('\n')
					.filter(
						(line) =>
							line.startsWith('Approval policy:') ||
							line.startsWith('Outside execution destination:')
					),
				policies: messages[1],
				records: await records(),
				leakedConfig: messages.join('\n').includes('synthetic-secret')
			}).toStrictEqual({
				settings: [
					'Approval policy: missing (unavailable)',
					'Outside execution destination: provider (rpc-provider)'
				],
				policies:
					'Available execution approval policies:\nuser: user\nalways: always\nnever: never\nrpc-failure: Failing reviewer',
				records: [],
				leakedConfig: false
			});
		},
		{
			config: {
				provider: 'rpc-provider',
				policy: {
					workspaceAccess: 'read-write',
					filesystemScope: 'provider-default',
					networkAccess: 'provider-default'
				},
				outsideSandbox: { destination: 'provider' },
				approval: { policy: 'missing', config: { secret: 'synthetic-secret' } }
			}
		}
	);
}, 20_000);

it.each(['normal', 'provider'] as const)(
	'reviews and dispatches the configured Bash prefix on %s',
	async (destination) => {
		const command = "printf 'normal\\n' >> executions; printf approved";
		const prefix = 'export BYOS_PREFIX_TEST=present';

		await fixture(
			async ({ rpc, effects, records }) => {
				await rpc.send({
					type: 'set_model',
					provider: 'scripted',
					modelId: 'scripted'
				});

				const requested = confirmation(rpc);
				const completed = toolResult(rpc);

				await rpc.send({
					type: 'prompt',
					message: 'Run the prefixed fixture tool.'
				});

				const request = await requested;
				const reviewed = request.message.split('\n\n', 2)[1];

				rpc.respond({
					type: 'extension_ui_response',
					id: request.id,
					confirmed: true
				});

				const result = await completed;
				const journal = await records();

				expect({
					reviewed,
					result,
					effects: await effects(),
					dispatched: journal.filter(
						(record) => isRecord(record) && record.kind === 'execute'
					)
				}).toStrictEqual({
					reviewed: `${prefix}\n${command}`,
					result: {
						tool: 'bash',
						content: [{ type: 'text', text: 'approved' }],
						isError: false
					},
					effects: `${destination}\n`,
					dispatched:
						destination === 'normal'
							? []
							: [
									{
										kind: 'execute',
										request: {
											kind: 'shell',
											dialect: 'bash',
											command: `${prefix}\n${command}`,
											cwd: '/rpc/target'
										}
									}
								]
				});
			},
			{ destination, mode: 'bash', shellCommandPrefix: prefix }
		);
	},
	20_000
);
