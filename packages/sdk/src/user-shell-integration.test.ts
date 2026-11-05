import type {
	ExtensionAPI,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { SandboxBroker } from './broker.js';
import { getSandbox } from './client.js';
import type {
	BackendProcessContext,
	ProcessRequest,
	SandboxBackend,
	SandboxContext,
	ShellDialect
} from './contracts.js';
import { discoverBroker } from './discovery.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { observe } from './lifecycle.js';
import type { ProviderServiceV1 } from './protocol.js';
import { ensureBroker } from './service.js';
import { registerUserShell } from './user-shell.js';

vi.mock(import('node:child_process'), async (importOriginal) => {
	const actual = await importOriginal();

	return {
		...actual,
		spawn: vi.fn(() => {
			throw new Error('A remote user shell must not start a host process.');
		})
	};
});

interface Config {
	readonly defaultShell: ShellDialect | undefined;
	readonly userShell?: ShellDialect;
	readonly shells: readonly ShellDialect[];
}

function fixture(
	config: Config,
	opening?: () => Promise<void>,
	run?: SandboxBackend['exec']
) {
	const template = new MemoryBackend('exec');
	const calls: ProcessRequest[] = [];
	const counts = { opens: 0 };
	const binding: { pi?: ExtensionAPI; context?: SandboxContext } = {};
	const backend: SandboxBackend = {
		id: 'target',
		workspace: {
			...template.workspace,
			...(config.defaultShell !== undefined && {
				defaultShell: config.defaultShell
			})
		},
		capabilities: {
			processKinds: config.shells.length === 0 ? ['argv'] : ['argv', 'shell'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: config.shells
		},
		policy: template.policy,
		policyDescription: template.policyDescription,
		recovery: template.recovery,
		exec(request: ProcessRequest, context: BackendProcessContext) {
			calls.push(request);
			context.onOutput({
				stream: 'stdout',
				data: new TextEncoder().encode('remote user output')
			});

			return (
				run?.(request, context) ??
				Promise.resolve({ kind: 'exited', exit: { kind: 'code', code: 7 } })
			);
		},
		dispose: () => Promise.resolve()
	};
	const provider: ProviderServiceV1 = {
		id: 'fixture',
		label: 'Fixture',
		capabilities: backend.capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		configure() {
			return {
				open: async () => {
					counts.opens++;
					await opening?.();

					return backend;
				}
			};
		}
	};
	const extension: InlineExtension = {
		name: 'sandbox-user-shell',
		factory(pi) {
			ensureBroker(
				pi.events,
				(id) =>
					new SandboxBroker(id, pi, {
						readConfig: () =>
							Promise.resolve({
								selection: {
									providerId: 'fixture',
									source: 'extension',
									policy: template.policy,
									...(config.userShell !== undefined && {
										userShell: config.userShell
									})
								},
								providerConfig: {}
							}),
						providers: () => [provider]
					})
			);
			binding.pi = pi;
			pi.on('session_start', (_event, context) => {
				binding.context = context;
			});
			registerUserShell(pi);
		}
	};

	return { extension, calls, counts, binding };
}

it.each([
	{ defaultShell: 'sh' as const, userShell: undefined, expected: 'sh' },
	{
		defaultShell: 'bash' as const,
		userShell: 'powershell' as const,
		expected: 'powershell'
	}
])(
	'selects configured or default user shell: $expected',
	async ({ defaultShell, userShell, expected }) => {
		const { extension, calls, counts } = fixture({
			defaultShell,
			...(userShell !== undefined && { userShell }),
			shells: ['bash', 'sh', 'powershell']
		});

		await withPiRuntime([extension], async (runtime, errors) => {
			const event = await runtime.session.extensionRunner.emitUserBash({
				type: 'user_bash',
				command: 'user command',
				excludeFromContext: false,
				cwd: runtime.session.sessionManager.getCwd()
			});

			expect({
				errors,
				calls,
				opens: counts.opens,
				hasOperations: event?.operations !== undefined
			}).toStrictEqual({
				errors: [],
				calls: [],
				opens: 0,
				hasOperations: true
			});

			if (event?.operations === undefined) {
				throw new Error('The adapter did not provide user-shell operations.');
			}

			const result = await runtime.session.executeBash(
				'user command',
				undefined,
				{ operations: event.operations }
			);

			expect({ result, calls, opens: counts.opens }).toStrictEqual({
				result: {
					output: 'remote user output',
					exitCode: 7,
					cancelled: false,
					truncated: false,
					fullOutputPath: undefined
				},
				calls: [
					{
						kind: 'shell',
						dialect: expected,
						command: 'user command',
						cwd: '/remote/project'
					}
				],
				opens: 1
			});
		});
	}
);

it.each([
	{ defaultShell: undefined, shells: ['bash'] as const },
	{
		defaultShell: 'bash' as const,
		userShell: 'powershell' as const,
		shells: ['bash'] as const
	}
])(
	'rejects missing or unsupported user-shell selection: %j',
	async (config) => {
		const { extension, calls } = fixture(config);

		await withPiRuntime([extension], async (runtime) => {
			const event = await runtime.session.extensionRunner.emitUserBash({
				type: 'user_bash',
				command: 'must not run',
				excludeFromContext: false,
				cwd: runtime.session.sessionManager.getCwd()
			});

			if (event?.operations === undefined) {
				throw new Error('The adapter did not provide user-shell operations.');
			}

			await expect(
				runtime.session.executeBash('must not run', undefined, {
					operations: event.operations
				})
			).rejects.toMatchObject({
				name: 'UnsupportedSandboxCapabilityError',
				operation: 'exec',
				providerId: 'fixture',
				backendId: 'target'
			});
			expect(calls).toStrictEqual([]);
		});
	}
);

it('cancels a cold startup waiter before the backend becomes ready', async () => {
	const started = Promise.withResolvers<'started'>();
	const finish = Promise.withResolvers<'ready'>();
	const { extension, calls, counts, binding } = fixture(
		{ defaultShell: 'bash', shells: ['bash'] },
		async () => {
			started.resolve('started');
			await finish.promise;
		}
	);

	await withPiRuntime([extension], async (runtime, errors) => {
		const event = await runtime.session.extensionRunner.emitUserBash({
			type: 'user_bash',
			command: 'cancelled user command',
			excludeFromContext: false,
			cwd: runtime.session.sessionManager.getCwd()
		});

		if (event?.operations === undefined) {
			throw new Error('The adapter did not provide user-shell operations.');
		}

		const running = observe(
			runtime.session.executeBash('cancelled user command', undefined, {
				operations: event.operations
			})
		);

		await started.promise;
		runtime.session.abortBash();

		const result = await running;

		finish.resolve('ready');

		if (binding.pi === undefined || binding.context === undefined) {
			throw new Error('The runtime binding is missing.');
		}

		const sandbox = await getSandbox(binding.pi, binding.context);

		expect(sandbox.backendId).toBe('target');
		expect({ errors, result, calls, opens: counts.opens }).toStrictEqual({
			errors: [],
			result: {
				kind: 'resolved',
				value: {
					output: '',
					exitCode: undefined,
					cancelled: true,
					truncated: false,
					fullOutputPath: undefined
				}
			},
			calls: [],
			opens: 1
		});
	});
});

it.each([false, true])(
	'keeps user shell exclusion in the model transcript: %s',
	async (excludeFromContext) => {
		const { extension, calls } = fixture({
			defaultShell: 'bash',
			shells: ['bash']
		});
		const model = new ScriptedModel([]);

		await withPiRuntime(
			[extension, model.extension],
			async (runtime, errors) => {
				const event = await runtime.session.extensionRunner.emitUserBash({
					type: 'user_bash',
					command: 'private user command',
					excludeFromContext,
					cwd: runtime.session.sessionManager.getCwd()
				});

				if (event?.operations === undefined) {
					throw new Error('The adapter did not provide user-shell operations.');
				}

				await runtime.session.executeBash('private user command', undefined, {
					operations: event.operations,
					excludeFromContext
				});

				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				await runtime.session.prompt('Inspect the previous command.');

				const messages = model.requests
					.at(0)
					?.messages.filter((message) => message.role === 'user')
					.map((message) => message.content);

				expect({
					errors,
					calls,
					requests: model.requests.length,
					messages
				}).toStrictEqual({
					errors: [],
					calls: [
						{
							kind: 'shell',
							command: 'private user command',
							dialect: 'bash',
							cwd: '/remote/project'
						}
					],
					requests: 1,
					messages: [
						...(excludeFromContext
							? []
							: [
									[
										{
											type: 'text',
											text: 'Ran `private user command`\n```\nremote user output\n```\n\nCommand exited with code 7'
										}
									]
								]),
						[{ type: 'text', text: 'Inspect the previous command.' }]
					]
				});
			}
		);
	}
);

it('keeps a configured startup failure and never switches to host execution', async () => {
	const { extension, calls, counts } = fixture(
		{ defaultShell: 'bash', shells: ['bash'] },
		() => Promise.reject(new Error('The provider is unavailable.'))
	);

	await withPiRuntime([extension], async (runtime, errors) => {
		const event = await runtime.session.extensionRunner.emitUserBash({
			type: 'user_bash',
			command: 'must not run',
			excludeFromContext: false,
			cwd: runtime.session.sessionManager.getCwd()
		});

		if (event?.operations === undefined) {
			throw new Error('The adapter did not provide user-shell operations.');
		}

		for (let attempt = 0; attempt < 2; attempt++) {
			await expect(
				runtime.session.executeBash('must not run', undefined, {
					operations: event.operations
				})
			).rejects.toMatchObject({
				name: 'SandboxStartupError',
				providerId: 'fixture'
			});
		}

		expect({ errors, calls, opens: counts.opens }).toStrictEqual({
			errors: [],
			calls: [],
			opens: 1
		});
	});
});

it('quarantines unconfirmed user-shell termination even when Pi returns a cancelled result', async () => {
	const started = Promise.withResolvers<'started'>();
	const { extension, calls, binding } = fixture(
		{ defaultShell: 'bash', shells: ['bash'] },
		undefined,
		async (_request, context) => {
			started.resolve('started');
			await new Promise<undefined>((resolve) => {
				context.signal.addEventListener(
					'abort',
					() => {
						resolve(undefined);
					},
					{ once: true }
				);
			});

			return { kind: 'cancelled', termination: 'unconfirmed' };
		}
	);

	await withPiRuntime([extension], async (runtime, errors) => {
		const event = await runtime.session.extensionRunner.emitUserBash({
			type: 'user_bash',
			command: 'uncertain command',
			excludeFromContext: false,
			cwd: runtime.session.sessionManager.getCwd()
		});

		if (event?.operations === undefined) {
			throw new Error('The adapter did not provide user-shell operations.');
		}

		const running = observe(
			runtime.session.executeBash('uncertain command', undefined, {
				operations: event.operations
			})
		);

		await started.promise;
		runtime.session.abortBash();

		const stopped = await running;

		await expect(
			runtime.session.executeBash('later command', undefined, {
				operations: event.operations
			})
		).rejects.toMatchObject({
			name: 'UnconfirmedSandboxTerminationError',
			completion: 'unknown'
		});

		if (binding.pi === undefined || binding.context === undefined) {
			throw new Error('The runtime binding is missing.');
		}

		const status = await discoverBroker(binding.pi.events)?.status(
			binding.context
		);

		expect({
			errors,
			stopped,
			calls,
			state: status?.state,
			failure: status?.failure?.name
		}).toStrictEqual({
			errors: [],
			stopped: {
				kind: 'resolved',
				value: {
					output: 'remote user output',
					exitCode: undefined,
					cancelled: true,
					truncated: false,
					fullOutputPath: undefined
				}
			},
			calls: [
				{
					kind: 'shell',
					dialect: 'bash',
					command: 'uncertain command',
					cwd: '/remote/project'
				}
			],
			state: 'failed',
			failure: 'UnconfirmedSandboxTerminationError'
		});
	});
});
