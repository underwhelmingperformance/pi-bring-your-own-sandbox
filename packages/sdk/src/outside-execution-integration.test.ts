import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import type {
	ApprovalDecision,
	ExecutionApprovalRequest,
	OutsideSandboxProvider
} from './approval-contracts.js';
import { ApprovalDeniedError } from './approval-errors.js';
import { closeSandboxSession, getSandbox } from './client.js';
import type {
	SandboxBackend,
	SandboxConfigContext,
	SandboxProvider
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import {
	UnconfirmedSandboxTerminationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import {
	APPROVAL_SERVICE_CHANNEL,
	registerApprovalPolicy,
	requestExecutionApproval
} from './execution-approval.js';
import { publishService } from './extension-services.js';
import { FixtureConfig } from './fixtures/config.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { initialiseSandboxHost } from './host.js';
import { OperationScope } from './lifecycle.js';
import {
	getOutsideSandboxExecutor,
	trackOutsideExecution
} from './outside-execution.js';
import { registerSandboxProvider } from './provider-registration.js';

afterEach(() => {
	vi.useRealTimers();
});

interface Scenario {
	readonly config: unknown;
	readonly normalExecutor?: OutsideSandboxProvider<undefined>;
	readonly extensions?: readonly InlineExtension[];
	readonly run: (pi: ExtensionAPI, context: ExtensionContext) => Promise<void>;
}

async function scenario({
	config,
	extensions = [],
	run,
	normalExecutor
}: Scenario) {
	const config_ = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'host',
				factory(pi) {
					initialiseSandboxHost(pi, {
						...(normalExecutor !== undefined && { normalExecutor })
					});
				}
			},
			...extensions,
			{
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('outside', {
						description: 'Fixture execution',
						handler: (_arguments, context) => run(pi, context)
					});
				}
			},
			{
				name: 'execution-settings',
				factory: (pi) => {
					config_.bind(pi);
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/outside');
			expect(errors).toStrictEqual([]);
		},
		{
			prepare: (_cwd, _agentDirectory) => {
				config_.set(config);
			}
		}
	);
}

it.each(['always', 'never'] as const)(
	'uses the %s policy without starting the selected sandbox',
	async (policy) => {
		await scenario({
			config: { approval: { policy } },
			async run(pi, context) {
				const executor = await getOutsideSandboxExecutor(pi, context);
				const request = {
					kind: 'argv',
					executable: process.execPath,
					args: ['-e', 'process.stdout.write("hello")']
				} as const;

				if (policy === 'never') {
					await expect(
						executor.exec(request, { justification: 'Print a greeting.' })
					).rejects.toBeInstanceOf(ApprovalDeniedError);

					return;
				}

				const result = await executor.exec(request, {
					justification: 'Print a greeting.'
				});

				expect({
					exit: result.exit,
					stdout: new TextDecoder().decode(result.stdout),
					stderr: new TextDecoder().decode(result.stderr)
				}).toStrictEqual({
					exit: { kind: 'code', code: 0 },
					stdout: 'hello',
					stderr: ''
				});
			}
		});
	}
);

it.each(['allow', 'deny'] as const)(
	'uses a separately installed %s policy with a provider destination',
	async (kind) => {
		const backend = new MemoryBackend();
		const executions = vi.fn(backend.exec.bind(backend));

		backend.exec = executions;

		const ordinaryOpen = vi.fn(() =>
			Promise.reject(new Error('The ordinary sandbox must not start.'))
		);
		const captured: ExecutionApprovalRequest[] = [];
		const provider: SandboxProvider<unknown> = {
			id: 'remote',
			label: 'Remote sandbox',
			protocolVersion: 1,
			defaultPolicy: backend.policy,
			capabilities: backend.capabilities,
			policies: {
				workspaceAccess: ['read-write'],
				filesystemScope: ['provider-default'],
				networkAccess: ['provider-default']
			},
			validateConfig: (input) => input,
			open: ordinaryOpen,
			outsideSandbox: {
				label: 'Remote outside execution',
				capabilities: backend.capabilities,
				policy: backend.policy,
				open: () => Promise.resolve(backend)
			}
		};

		await scenario({
			config: {
				provider: 'remote',
				policy: backend.policy,
				approval: { policy: 'fixture' },
				outsideSandbox: { destination: 'provider' }
			},
			extensions: [
				{
					name: 'provider',
					factory: (pi) => {
						registerSandboxProvider(pi, provider);
					}
				},
				{
					name: 'policy',
					factory: (pi) => {
						registerApprovalPolicy(pi, {
							id: 'fixture',
							label: 'Fixture approval',
							protocolVersion: 1,
							validateConfig: (input) => input,
							decide(request) {
								captured.push(request);

								return Promise.resolve({ kind });
							}
						});
					}
				}
			],
			async run(pi, context) {
				const executor = await getOutsideSandboxExecutor(pi, context);
				const request = {
					kind: 'argv',
					executable: 'echo',
					args: ['test'],
					cwd: executor.destination.workspace.root
				} as const;
				const running = executor.exec(request, {
					justification: 'Run the remote fixture.'
				});

				if (kind === 'deny') {
					await expect(running).rejects.toBeInstanceOf(ApprovalDeniedError);
				} else {
					await running;
				}

				expect({
					ordinary: ordinaryOpen.mock.calls,
					executions: executions.mock.calls.length,
					reviewed: captured
				}).toStrictEqual({
					ordinary: [],
					executions: kind === 'allow' ? 1 : 0,
					reviewed: [
						{
							process: request,
							destination: executor.destination,
							justification: 'Run the remote fixture.'
						}
					]
				});
			}
		});
	}
);

it('fails when the selected provider has no outside capability', async () => {
	const backend = new MemoryBackend();

	await scenario({
		config: {
			provider: 'fixture',
			policy: backend.policy,
			outsideSandbox: { destination: 'provider' },
			approval: { policy: 'always' }
		},
		extensions: [
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, {
						id: 'fixture',
						label: 'Fixture',
						protocolVersion: 1,
						defaultPolicy: backend.policy,
						capabilities: backend.capabilities,
						policies: {
							workspaceAccess: ['read-write'],
							filesystemScope: ['provider-default'],
							networkAccess: ['provider-default']
						},
						validateConfig: (input) => input,
						open: () => Promise.resolve(backend)
					});
				}
			}
		],
		async run(pi, context) {
			await expect(
				getOutsideSandboxExecutor(pi, context)
			).rejects.toMatchObject({ name: 'UnsupportedSandboxCapabilityError' });
		}
	});
});

it('ignores a late allow after cancellation', async () => {
	const entered = Promise.withResolvers<undefined>();
	const decision = Promise.withResolvers<ApprovalDecision>();

	await scenario({
		config: { approval: { policy: 'delayed' } },
		extensions: [
			{
				name: 'policy',
				factory(pi) {
					registerApprovalPolicy(pi, {
						id: 'delayed',
						label: 'Delayed',
						protocolVersion: 1,
						validateConfig: (input) => input,
						decide() {
							entered.resolve(undefined);

							return decision.promise;
						}
					});
				}
			}
		],
		async run(pi, context) {
			const executor = await getOutsideSandboxExecutor(pi, context);
			const cancellation = new AbortController();
			const running = executor.exec(
				{
					kind: 'argv',
					executable: process.execPath,
					args: ['-e', 'throw new Error("must not execute")']
				},
				{ justification: 'Test cancellation.', signal: cancellation.signal }
			);

			await entered.promise;
			cancellation.abort();
			await expect(running).rejects.toMatchObject({
				name: 'SandboxCancelledError',
				completion: 'not-started'
			});
			decision.resolve({ kind: 'allow' });
		}
	});
});

it.each([true, false])(
	'prompts the user and returns their decision: %s',
	async (allowed) => {
		await scenario({
			config: {},
			async run(pi, context) {
				const isAllowed = vi.fn(() => Promise.resolve(allowed));
				const executor = await getOutsideSandboxExecutor(pi, context);
				const result = await requestExecutionApproval(
					pi,
					{
						...context,
						hasUI: true,
						ui: { ...context.ui, confirm: isAllowed }
					},
					{
						process: { kind: 'shell', dialect: 'sh', command: 'printf hello' },
						destination: executor.destination,
						justification: 'Print a greeting.'
					}
				);

				expect(result).toStrictEqual({ kind: allowed ? 'allow' : 'deny' });
				expect(isAllowed.mock.calls).toHaveLength(1);
			}
		});
	}
);

it('closes an embedded normal executor through the SDK shutdown helper', async () => {
	const backend = new MemoryBackend('exec');
	let disposals = 0;

	backend.dispose = () => {
		disposals++;

		return Promise.resolve();
	};

	await scenario({
		config: { approval: { policy: 'always' } },
		normalExecutor: {
			label: 'Embedded remote environment',
			capabilities: backend.capabilities,
			policy: backend.policy,
			open: () => Promise.resolve(backend)
		},
		async run(pi, context) {
			const executor = await getOutsideSandboxExecutor(pi, context);
			const report = await closeSandboxSession(pi, context);

			expect({
				report,
				disposals,
				destination: executor.destination.workspace.relationship
			}).toStrictEqual({
				report: { confirmed: true, failures: [], recoveries: [] },
				disposals: 1,
				destination: 'remote'
			});
			await expect(
				executor.exec(
					{ kind: 'argv', executable: 'probe', args: [] },
					{ justification: 'Already closed.' }
				)
			).rejects.toMatchObject({
				name: 'SandboxSessionClosingError'
			});
		}
	});
});

it('rejects new outside and approval services after explicit SDK shutdown', async () => {
	await scenario({
		config: { approval: { policy: 'always' } },
		async run(pi, context) {
			await closeSandboxSession(pi, context);
			await expect(
				getOutsideSandboxExecutor(pi, context)
			).rejects.toMatchObject({ name: 'SandboxSessionClosingError' });
			await expect(
				requestExecutionApproval(pi, context, {
					process: { kind: 'argv', executable: 'probe', args: [] },
					justification: 'Must remain closed.',
					destination: {
						kind: 'normal',
						id: 'normal',
						label: 'Normal execution',
						policyDescription: 'Normal environment.',
						workspace: {
							root: context.cwd,
							pathFlavor: 'posix',
							relationship: 'shared',
							description: 'Shared workspace.'
						}
					}
				})
			).rejects.toMatchObject({ name: 'SandboxSessionClosingError' });
		}
	});
});

it('snapshots acquisition requirements before awaiting configuration', async () => {
	await scenario({
		config: { approval: { policy: 'always' } },
		async run(pi, context) {
			const policy: { networkAccess: 'denied' | 'provider-default' } = {
				networkAccess: 'denied'
			};
			const acquiring = getOutsideSandboxExecutor(pi, context, { policy });

			policy.networkAccess = 'provider-default';
			await expect(acquiring).rejects.toMatchObject({
				name: 'UnsupportedSandboxPolicyError'
			});
		}
	});
});

it.each(['normal', 'provider'] as const)(
	'rejects unsupported outside argv before approval on %s',
	async (destination) => {
		const template = shellBackend().backend;
		const execute = vi.fn(template.exec);
		const review = vi.fn(() => Promise.resolve({ kind: 'allow' as const }));
		const backend: SandboxBackend = {
			...template,
			capabilities: {
				operations: ['exec'],
				processKinds: ['shell'],
				shells: ['bash'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed'
			},
			exec: execute
		};
		const outside = {
			label: 'Shell-only outside fixture',
			capabilities: backend.capabilities,
			policy: backend.policy,
			open: () => Promise.resolve(backend)
		};

		await scenario({
			config: {
				provider: 'fixture',
				policy: backend.policy,
				approval: { policy: 'review' },
				outsideSandbox: { destination }
			},
			normalExecutor: outside,
			extensions: [
				{
					name: 'policy',
					factory(pi) {
						registerApprovalPolicy(pi, {
							id: 'review',
							label: 'Review fixture',
							protocolVersion: 1,
							validateConfig: () => ({}),
							decide: review
						});
					}
				},
				{
					name: 'provider',
					factory(pi) {
						registerSandboxProvider(pi, {
							id: 'fixture',
							label: 'Fixture',
							protocolVersion: 1,
							defaultPolicy: backend.policy,
							capabilities: backend.capabilities,
							policies: {
								workspaceAccess: ['read-write'],
								filesystemScope: ['provider-default'],
								networkAccess: ['provider-default']
							},
							validateConfig: () => ({}),
							open: () => Promise.resolve(backend),
							outsideSandbox: outside
						});
					}
				}
			],
			async run(pi, context) {
				const executor = await getOutsideSandboxExecutor(pi, context);

				await expect(
					executor.exec(
						{ kind: 'argv', executable: 'probe', args: [] },
						{ justification: 'Check request support.' }
					)
				).rejects.toBeInstanceOf(UnsupportedSandboxCapabilityError);
				expect({
					reviews: review.mock.calls,
					executions: execute.mock.calls
				}).toStrictEqual({ reviews: [], executions: [] });
			}
		});
	}
);

it('expires a queued user request without opening another confirmation', async () => {
	await scenario({
		config: {},
		async run(pi, context) {
			const executor = await getOutsideSandboxExecutor(pi, context);
			const first = Promise.withResolvers<boolean>();
			const entered = Promise.withResolvers<undefined>();
			let prompts = 0;
			const prompting = {
				...context,
				hasUI: true,
				ui: {
					...context.ui,
					confirm: () => {
						prompts++;
						entered.resolve(undefined);

						return first.promise;
					}
				}
			};
			const request = {
				process: { kind: 'argv' as const, executable: 'probe', args: [] },
				destination: executor.destination,
				justification: 'Review the fixture.'
			};

			vi.useFakeTimers();

			try {
				const pending = requestExecutionApproval(pi, prompting, request, {
					timeoutMs: 100
				});

				await entered.promise;

				const queued = requestExecutionApproval(pi, prompting, request, {
					timeoutMs: 10
				});
				const rejected = expect(queued).rejects.toMatchObject({
					name: 'SandboxTimeoutError',
					completion: 'not-started'
				});

				await vi.advanceTimersByTimeAsync(10);
				await rejected;
				first.resolve(true);

				const decision = await pending;

				expect({ decision, prompts }).toStrictEqual({
					decision: { kind: 'allow' },
					prompts: 1
				});
			} finally {
				vi.useRealTimers();
			}
		}
	});
});

it('reports native termination failures during Pi session shutdown', async () => {
	const config1 = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'cleanup',
				factory(pi) {
					initialiseSandboxHost(pi, {});
					pi.registerCommand('unconfirmed', {
						description: 'Record an unconfirmed native operation.',
						async handler(_arguments, context) {
							await getOutsideSandboxExecutor(pi, context);

							const scope = new OperationScope(
								{ operation: 'exec' },
								new AbortController().signal,
								{},
								1000
							);

							try {
								await expect(
									trackOutsideExecution(pi, scope, () =>
										Promise.reject(
											new UnconfirmedSandboxTerminationError({
												operation: 'exec'
											})
										)
									)
								).rejects.toThrow();
							} finally {
								scope.dispose();
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
			await runtime.session.prompt('/unconfirmed');
			await runtime.session.extensionRunner.emit({
				type: 'session_shutdown',
				reason: 'quit'
			});

			const reports = runtime.session.messages.flatMap((message) =>
				message.role === 'custom' && message.customType === 'byos'
					? [message.content]
					: []
			);

			expect({ errors, reports }).toStrictEqual({
				errors: [],
				reports: [
					'Cleanup: incomplete\nCleanup error: UnconfirmedSandboxTerminationError: The sandbox did not confirm termination. Operation completion is unknown.'
				]
			});
		}
	);
});

it('closes execution backends even when an approval service fails to close', async () => {
	const backend = new MemoryBackend('exec');
	let disposals = 0;

	backend.dispose = () => {
		disposals++;

		return Promise.resolve();
	};

	await scenario({
		config: {},
		normalExecutor: {
			label: 'Embedded normal executor',
			capabilities: backend.capabilities,
			policy: backend.policy,
			open: () => Promise.resolve(backend)
		},
		async run(pi, context) {
			await getOutsideSandboxExecutor(pi, context);
			await getSandbox(pi, context);

			const service = {
				id: 'throwing-approval-service',
				request: () => Promise.resolve({ kind: 'deny' }),
				policies: () => [],
				close() {
					throw new Error('Approval cleanup failed.');
				}
			};

			publishService(pi.events, APPROVAL_SERVICE_CHANNEL, service);

			const report = await closeSandboxSession(pi, context);

			expect({
				disposals,
				report: { ...report, failures: report.failures.map(({ name }) => name) }
			}).toStrictEqual({
				disposals: 1,
				report: {
					confirmed: false,
					failures: ['SandboxCleanupError'],
					recoveries: []
				}
			});
		}
	});
});

it('cancels a pending standalone review when malformed discovery prevents policy service closure', async () => {
	const started = Promise.withResolvers<undefined>();
	const decision = Promise.withResolvers<ApprovalDecision>();

	await scenario({
		config: { approval: { policy: 'deferred' } },
		extensions: [
			{
				name: 'reviewer',
				factory(pi) {
					registerApprovalPolicy(pi, {
						id: 'deferred',
						label: 'Deferred reviewer',
						protocolVersion: 1,
						validateConfig: () => ({}),
						decide() {
							started.resolve(undefined);

							return decision.promise;
						}
					});
				}
			}
		],
		async run(pi, context) {
			const executor = await getOutsideSandboxExecutor(pi, context);
			const reviewing = requestExecutionApproval(pi, context, {
				process: { kind: 'argv', executable: 'probe', args: [] },
				destination: executor.destination,
				justification: 'Check shutdown cancellation.'
			});
			const outcome = expect(reviewing).rejects.toMatchObject({
				name: 'SandboxCancelledError',
				reason: 'shutdown',
				completion: 'not-started'
			});

			await started.promise;
			publishService(pi.events, APPROVAL_SERVICE_CHANNEL, { id: 'malformed' });

			const report = await closeSandboxSession(pi, context);

			decision.resolve({ kind: 'allow' });
			await outcome;
			expect({
				...report,
				failures: report.failures.map(({ name }) => name)
			}).toStrictEqual({
				confirmed: false,
				failures: ['InvalidSandboxDeclarationError'],
				recoveries: []
			});
		}
	});
});

it('preserves the SDK deadline while an approval policy is still pending', async () => {
	const started = Promise.withResolvers<undefined>();
	const decision = Promise.withResolvers<ApprovalDecision>();

	await scenario({
		config: { approval: { policy: 'deferred' } },
		extensions: [
			{
				name: 'reviewer',
				factory(pi) {
					registerApprovalPolicy(pi, {
						id: 'deferred',
						label: 'Deferred reviewer',
						protocolVersion: 1,
						validateConfig: () => ({}),
						decide() {
							started.resolve(undefined);

							return decision.promise;
						}
					});
				}
			}
		],
		async run(pi, context) {
			const executor = await getOutsideSandboxExecutor(pi, context);

			vi.useFakeTimers();

			const running = executor.exec(
				{ kind: 'argv', executable: 'probe', args: [] },
				{ justification: 'Check the review deadline.', timeoutMs: 10 }
			);
			const failed = expect(running).rejects.toMatchObject({
				name: 'SandboxTimeoutError',
				reason: 'deadline',
				completion: 'not-started'
			});

			await started.promise;
			await vi.advanceTimersByTimeAsync(10);
			await failed;
			decision.resolve({ kind: 'deny' });
		}
	});
});

it('retains configuration warnings when outside execution resolves settings first', async () => {
	const backend = new MemoryBackend('exec');
	const configure = vi.fn((context: SandboxConfigContext) => {
		context.reportDiagnostic({
			level: 'warning',
			message: 'Using the extension configuration default.'
		});

		return { configuration: {} };
	});
	const open = vi.fn(() => Promise.resolve(backend));

	await scenario({
		config: {},
		extensions: [
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(
						pi,
						{
							id: 'fixture',
							label: 'Configuration fixture',
							protocolVersion: 1,
							capabilities: backend.capabilities,
							defaultPolicy: backend.policy,
							policies: {
								workspaceAccess: ['read-write'],
								filesystemScope: ['provider-default'],
								networkAccess: ['provider-default']
							},
							validateConfig: () => ({}),
							open
						},
						{ configure }
					);
				}
			}
		],
		async run(pi, context) {
			await getOutsideSandboxExecutor(pi, context);

			const status = await ensureSandboxService(pi).status(context);
			const operationId: unknown = expect.any(String);

			expect({
				diagnostics: status.diagnostics,
				resolutions: configure.mock.calls.length,
				openings: open.mock.calls
			}).toStrictEqual({
				diagnostics: [
					{
						level: 'warning',
						message: 'Using the extension configuration default.',
						operation: 'configure',
						operationId,
						providerId: 'fixture'
					}
				],
				resolutions: 1,
				openings: []
			});
		}
	});
});
