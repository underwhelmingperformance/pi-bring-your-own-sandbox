import { expect, it, vi } from 'vitest';

import { getSandbox } from './client.js';
import type { SandboxAcquireOptions, SandboxBackend } from './contracts.js';
import { discoverBroker } from './discovery.js';
import { isSandboxError } from './errors.js';
import { FixtureConfig } from './fixtures/config.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { fixtureProfile, fixtureProfiles } from './fixtures/profile-fixture.js';
import { initialiseSandboxHost } from './host.js';
import { observe } from './lifecycle.js';
import { profileCapabilities } from './validation.js';

it('keeps sandbox execution usable after cancellation without a termination guarantee', async () => {
	const template = new MemoryBackend('exec');
	const pending = Promise.withResolvers<never>();
	const started = Promise.withResolvers<undefined>();
	let disposals = 0;
	let calls = 0;
	const backend: SandboxBackend = {
		id: template.id,
		workspace: template.workspace,

		policyDescription: template.policyDescription,
		recovery: template.recovery,
		profile: fixtureProfile(template.policy, {
			...template.capabilities,
			terminationScope: 'none'
		}),
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

	try {
		const config = new FixtureConfig();

		await withPiRuntime(
			[
				{
					name: 'scope-fixture',
					factory(pi) {
						const host = initialiseSandboxHost(pi, import.meta.filename, {});

						config.activate(pi, {
							id: 'fixture',
							label: 'Termination fixture',
							profiles: fixtureProfiles(profileCapabilities(backend.profile), {
								hostWorkspaceWrites: [true],
								hostUserData: ['denied'],
								hostSystemFiles: ['read-only'],
								network: [false]
							}),

							validateConfig: () => ({}),
							open: () => Promise.resolve(backend)
						});
						pi.registerCommand('termination-test', {
							description: 'Exercise declared termination scope.',
							async handler(_arguments, context) {
								const acquire = (options: SandboxAcquireOptions = {}) =>
									getSandbox(pi, context, options);
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
										executor.exec(request, { signal: controller.signal })
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

									const result = await executor.exec(request);
									const status = await discoverBroker(pi.events)?.status(
										context
									);

									expect({
										result: { ...result, durationMs: 0 },
										state: status?.state,
										report: await host.close(),
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
										state: 'ready',
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
						policy: backend.profile.policy
					});
				}
			}
		);
	} finally {
		pending.reject(new Error('Release the fixture.'));
		vi.useRealTimers();
	}
});
