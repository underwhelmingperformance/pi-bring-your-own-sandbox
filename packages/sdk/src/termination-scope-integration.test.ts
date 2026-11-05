import { expect, it, vi } from 'vitest';

import { closeSandboxSession, getSandbox } from './client.js';
import type { SandboxAcquireOptions, SandboxBackend } from './contracts.js';
import { discoverBroker } from './discovery.js';
import { isSandboxError } from './errors.js';
import { FixtureConfig } from './fixtures/config.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { initialiseSandboxHost } from './host.js';
import { observe } from './lifecycle.js';
import { getOutsideSandboxExecutor } from './outside-execution.js';
import { outsideShellOperations } from './outside-shell-operations.js';

it.each(['sandbox', 'normal', 'provider'] as const)(
	'keeps %s execution usable after cancellation without a termination guarantee',
	async (destination) => {
		const template = new MemoryBackend('exec');
		const pending = Promise.withResolvers<never>();
		const started = Promise.withResolvers<undefined>();
		let disposals = 0;
		let calls = 0;
		const backend: SandboxBackend = {
			id: template.id,
			workspace: template.workspace,
			policy: template.policy,
			policyDescription: template.policyDescription,
			recovery: template.recovery,
			capabilities: { ...template.capabilities, terminationScope: 'none' },
			exec() {
				calls++;

				if (calls === 1) {
					started.resolve(undefined);

					return pending.promise;
				}

				return Promise.resolve({
					kind: 'exited',
					exit: { kind: 'code', code: 0 }
				});
			},
			dispose() {
				disposals++;

				return Promise.resolve();
			}
		};
		const outside = {
			label: 'Fixture destination',
			capabilities: backend.capabilities,
			policy: backend.policy,
			open: () => Promise.resolve(backend)
		};

		try {
			const config = new FixtureConfig();

			await withPiRuntime(
				[
					{
						name: 'scope-fixture',
						factory(pi) {
							initialiseSandboxHost(pi, {
								...(destination === 'normal' && { normalExecutor: outside })
							});
							config.activate(pi, {
								id: 'fixture',
								label: 'Termination fixture',
								protocolVersion: 1,
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
							pi.registerCommand('termination-test', {
								description: 'Exercise declared termination scope.',
								async handler(_arguments, context) {
									const acquire = (options: SandboxAcquireOptions = {}) =>
										destination === 'sandbox'
											? getSandbox(pi, context, options)
											: getOutsideSandboxExecutor(pi, context, options);
									const executor = await acquire();

									await expect(
										acquire({ terminationScope: 'workload' })
									).rejects.toMatchObject({
										name: 'UnsupportedSandboxCapabilityError'
									});

									vi.useFakeTimers();

									try {
										const controller = new AbortController();
										const request = {
											kind: 'argv',
											executable: 'wait',
											args: []
										} as const;
										const running = observe(
											'destination' in executor
												? executor.exec(request, {
														justification: 'Check cancellation scope.',
														signal: controller.signal
													})
												: executor.exec(request, { signal: controller.signal })
										);
										let cancellation: unknown;

										async function record() {
											const result = await running;

											cancellation =
												result.kind === 'rejected' &&
												isSandboxError(result.error) &&
												'completion' in result.error
													? {
															name: result.error.name,
															completion: result.error.completion
														}
													: result;
										}

										const recorded = record();

										await vi.advanceTimersByTimeAsync(0);
										await started.promise;
										controller.abort();
										await vi.advanceTimersByTimeAsync(0);
										expect(cancellation).toStrictEqual({
											name: 'SandboxCancelledError',
											completion: 'not-guaranteed'
										});
										await recorded;
										pending.reject(new Error('A late provider failure.'));
										await vi.advanceTimersByTimeAsync(0);

										const result =
											'destination' in executor
												? await executor.exec(request, {
														justification: 'Verify continued execution.'
													})
												: await executor.exec(request);
										const status = await discoverBroker(pi.events)?.status(
											context
										);

										expect({
											result: { ...result, durationMs: 0 },
											state:
												destination === 'sandbox' ? status?.state : undefined,
											report: await closeSandboxSession(pi, context),
											calls,
											disposals
										}).toStrictEqual({
											result: {
												exit: { kind: 'code', code: 0 },
												stdout: new Uint8Array(),
												stderr: new Uint8Array(),
												omittedBytes: { stdout: 0, stderr: 0 },
												durationMs: 0
											},
											state: destination === 'sandbox' ? 'ready' : undefined,
											report: { confirmed: true, failures: [], recoveries: [] },
											calls: 2,
											disposals: 1
										});
									} finally {
										pending.reject(new Error('Release the fixture.'));
										vi.useRealTimers();
									}
								}
							});
						}
					},
					{
						name: 'execution-settings',
						factory: (pi) => {
							config.bind(pi);
						}
					}
				],
				async (runtime, errors) => {
					await runtime.session.prompt('/termination-test');
					expect(errors).toStrictEqual([]);
				},
				{
					prepare(_cwd, _personal) {
						config.set({
							provider: 'fixture',
							policy: backend.policy,
							approval: { policy: 'always' },
							...(destination !== 'sandbox' && {
								outsideSandbox: { destination }
							})
						});
					}
				}
			);
		} finally {
			pending.reject(new Error('Release the fixture.'));
			vi.useRealTimers();
		}
	}
);

it('reports native Pi outside-shell cancellation without a termination guarantee', async () => {
	const config1 = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'native-shell-fixture',
				factory(pi) {
					initialiseSandboxHost(pi, {});
					pi.registerCommand('native-scope-test', {
						description: 'Exercise native Pi cancellation.',
						async handler(_arguments, context) {
							const controller = new AbortController();
							const shell = outsideShellOperations(
								pi,
								context,
								'bash',
								'Check native cancellation.'
							);
							const result = await observe(
								shell.exec('printf ready; sleep 60', context.cwd, {
									signal: controller.signal,
									onData() {
										controller.abort();
									}
								})
							);
							const error =
								result.kind === 'rejected' && result.error instanceof Error
									? result.error
									: undefined;

							expect({
								message: error?.message,
								cause:
									isSandboxError(error?.cause) && 'completion' in error.cause
										? {
												name: error.cause.name,
												completion: error.cause.completion
											}
										: error?.cause
							}).toStrictEqual({
								message: 'aborted',
								cause: {
									name: 'SandboxCancelledError',
									completion: 'not-guaranteed'
								}
							});

							const output: string[] = [];
							const next = await shell.exec('printf next', context.cwd, {
								onData(data) {
									output.push(data.toString());
								}
							});

							expect({
								next,
								output,
								report: await closeSandboxSession(pi, context)
							}).toStrictEqual({
								next: { exitCode: 0 },
								output: ['next'],
								report: { confirmed: true, failures: [], recoveries: [] }
							});
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
			await runtime.session.prompt('/native-scope-test');
			expect(errors).toStrictEqual([]);
		},
		{
			prepare(_cwd, _personal) {
				config1.set({ approval: { policy: 'always' } });
			}
		}
	);
});
