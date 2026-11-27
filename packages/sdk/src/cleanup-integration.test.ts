import { afterEach, expect, it, vi } from 'vitest';

import { getSandbox } from './client.js';
import type {
	BackendProcessOutcome,
	SandboxBackend,
	SandboxHostHandle,
	SandboxOperationContext
} from './contracts.js';
import { FixtureConfig } from './fixtures/config.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { fixtureProfiles } from './fixtures/profile-fixture.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { initialiseSandboxHost } from './host.js';
import { observe } from './lifecycle.js';
import { profileCapabilities } from './validation.js';

afterEach(() => {
	vi.useRealTimers();
});

it('uses the generation cleanup budgets for sandbox execution and disposal', async () => {
	let host: SandboxHostHandle | undefined;
	let isRunning = false;
	let isDisposed = false;
	let execution: SandboxOperationContext | undefined;
	let disposal: SandboxOperationContext | undefined;
	const template = shellBackend().backend;
	const backend: SandboxBackend = {
		...template,
		exec(_request, context) {
			isRunning = true;
			execution = context;

			return new Promise<BackendProcessOutcome>((resolve) => {
				context.signal.addEventListener(
					'abort',
					() => {
						setTimeout(() => {
							isRunning = false;
							resolve({ kind: 'cancelled', termination: 'confirmed' });
						}, 6000);
					},
					{ once: true }
				);
			});
		},
		dispose(context) {
			disposal = context;

			return new Promise((resolve) => {
				setTimeout(() => {
					isDisposed = true;
					resolve();
				}, 7000);
			});
		}
	};
	const config = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'host',
				factory(pi) {
					host = initialiseSandboxHost(pi, import.meta.filename, {
						cleanup: { cancellationGraceMs: 9000, disposalTimeoutMs: 9000 }
					});
				}
			},
			{
				name: 'provider',
				factory(pi) {
					config.activate(pi, {
						id: 'fixture',
						label: 'Cleanup fixture',
						profiles: fixtureProfiles(profileCapabilities(backend.profile), {
							hostWorkspaceWrites: [true],
							hostUserData: ['denied'],
							hostSystemFiles: ['read-only'],
							network: [false]
						}),

						validateConfig: () => ({}),
						open: () => Promise.resolve(backend)
					});
				}
			},
			{
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('cleanup-test', {
						description:
							'Exercise cleanup deadlines through a real Pi runtime.',
						async handler(_arguments, context) {
							if (host === undefined) {
								throw new Error('Pi did not initialise the cleanup host.');
							}

							const executor = await getSandbox(pi, context);

							expect(executor.cleanupBudgets).toStrictEqual({
								cancellationGraceMs: 8000,
								disposalTimeoutMs: 9000
							});

							vi.useFakeTimers();
							vi.setSystemTime(1000);

							try {
								const caller = new AbortController();
								const request = {
									kind: 'shell',
									dialect: 'bash',
									command: 'wait'
								} as const;
								const running = executor.exec(request, {
									signal: caller.signal
								});
								const completion = observe(running);

								await vi.advanceTimersByTimeAsync(0);
								expect(isRunning).toBe(true);
								caller.abort();
								expect(execution?.cleanup.deadline).toBe(9000);
								await vi.advanceTimersByTimeAsync(6000);
								expect(await completion).toMatchObject({
									kind: 'rejected',
									error: {
										name: 'SandboxCancelledError',
										completion: 'confirmed'
									}
								});
								expect(isRunning).toBe(false);

								const closing = host.close();

								await vi.advanceTimersByTimeAsync(0);
								expect({
									deadline: disposal?.deadline,
									cleanup: disposal?.cleanup.deadline
								}).toStrictEqual({ deadline: 16_000, cleanup: 16_000 });
								await vi.advanceTimersByTimeAsync(7000);
								expect({ report: await closing, isDisposed }).toStrictEqual({
									report: { confirmed: true, failures: [], recoveries: [] },
									isDisposed: true
								});
							} finally {
								const closing = host.close();

								await vi.runAllTimersAsync();
								await closing;
								vi.useRealTimers();
							}
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/cleanup-test');
			expect(errors).toStrictEqual([]);
		},
		{
			prepare(_directory, _personal) {
				config.set({
					provider: 'fixture',
					policy: backend.profile.policy,
					cleanup: { cancellationGraceMs: 8000 }
				});
			}
		}
	);
});
