import { expect, it, vi } from 'vitest';

import { configureExecutionApproval } from './api.js';
import type {
	ApprovalDecision,
	ExecutionApprovalRequest
} from './approval-contracts.js';
import {
	approvalService,
	registerApprovalPolicy,
	requestExecutionApproval
} from './execution-approval.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';

it('denies a user request without dialog-capable UI and allocates no sandbox', async () => {
	await withPiRuntime(
		[
			{
				name: 'consumer',
				factory(pi) {
					pi.registerCommand('approve', {
						description: 'Fixture',
						async handler(_arguments, context) {
							await expect(
								requestExecutionApproval(pi, context, {
									process: {
										kind: 'argv',
										executable: 'echo',
										args: ['hello']
									},
									justification: 'Print a greeting.',
									destination: {
										kind: 'normal',
										id: 'normal',
										label: 'Normal execution',
										workspace: {
											root: context.cwd,
											pathFlavor: 'posix',
											relationship: 'shared',
											description: 'Shared workspace.'
										},
										policyDescription: 'Normal environment.'
									}
								})
							).rejects.toMatchObject({ name: 'ApprovalUnavailableError' });
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/approve');
			expect(errors).toStrictEqual([]);
		}
	);
});

it('rejects duplicate custom policies with the approval-specific error', async () => {
	const id = 'duplicate';

	await withPiRuntime(
		[
			{
				name: 'policies',
				factory(pi) {
					const policy = {
						id,
						label: 'Fixture policy',
						protocolVersion: 1 as const,
						validateConfig: () => ({}),
						decide: () => Promise.resolve({ kind: 'allow' as const })
					};

					registerApprovalPolicy(pi, policy);

					registerApprovalPolicy(pi, policy);

					pi.registerCommand('duplicates', {
						description: 'Check duplicate policy errors.',
						async handler() {
							await expect(
								Promise.try(() => approvalService(pi).policies())
							).rejects.toMatchObject({ name: 'DuplicateApprovalPolicyError' });
						}
					});
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/duplicates');
			expect(errors).toStrictEqual([]);
		}
	);
});

it.each([-1_000_000, 1_000_000])(
	'consumes the queued prompt budget across a wall-clock jump to %s',
	async (wallTime) => {
		await withPiRuntime(
			[
				{
					name: 'queued-approval',
					factory(pi) {
						pi.registerCommand('queued', {
							description: 'Check queued approval deadlines.',
							async handler(_arguments, context) {
								vi.useFakeTimers();
								vi.setSystemTime(1000);

								const shown = Promise.withResolvers<undefined>();
								const release = Promise.withResolvers<boolean>();
								const timeouts: (number | undefined)[] = [];
								const uiContext = {
									...context,
									hasUI: true,
									ui: {
										...context.ui,
										confirm(
											_title: string,
											_message: string,
											options?: { timeout?: number }
										) {
											timeouts.push(options?.timeout);
											shown.resolve(undefined);

											return timeouts.length === 1
												? release.promise
												: Promise.resolve(true);
										}
									}
								};
								const request: ExecutionApprovalRequest = {
									process: { kind: 'argv', executable: 'probe', args: [] },
									justification: 'Check the queued prompt allowance.',
									destination: {
										kind: 'normal',
										id: 'normal',
										label: 'Fixture',
										workspace: {
											root: context.cwd,
											pathFlavor: 'posix',
											relationship: 'shared',
											description: 'Fixture workspace.'
										},
										policyDescription: 'Fixture policy.'
									}
								};

								try {
									const first = requestExecutionApproval(
										pi,
										uiContext,
										request,
										{ timeoutMs: 1000 }
									);

									await shown.promise;

									const second = requestExecutionApproval(
										pi,
										uiContext,
										request,
										{ timeoutMs: 1000 }
									);

									await vi.advanceTimersByTimeAsync(100);
									vi.setSystemTime(wallTime);
									release.resolve(true);

									expect({
										decisions: await Promise.all([first, second]),
										timeouts
									}).toStrictEqual({
										decisions: [{ kind: 'allow' }, { kind: 'allow' }],
										timeouts: [1000, 900]
									});
								} finally {
									release.resolve(false);
									vi.useRealTimers();
								}
							}
						});
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/queued');
				expect(errors).toStrictEqual([]);
			}
		);
	}
);

it.each([
	{ config: undefined, expected: {} },
	{ config: { enabled: true }, expected: { enabled: true } }
])(
	'normalises optional approval configuration: $config',
	async ({ config, expected }) => {
		const validateConfig = vi.fn((input: unknown) => input);
		const decisions: ApprovalDecision[] = [];

		await withPiRuntime(
			[
				{
					name: 'configured-approval',
					factory(pi) {
						configureExecutionApproval(pi, () => ({
							policy: 'fixture.config',
							config
						}));
						registerApprovalPolicy(pi, {
							id: 'fixture.config',
							label: 'Fixture policy',
							protocolVersion: 1,
							validateConfig,
							decide: () => Promise.resolve({ kind: 'allow' })
						});
						pi.registerCommand('configured', {
							description: 'Check optional approval configuration.',
							async handler(_arguments, context) {
								decisions.push(
									await requestExecutionApproval(pi, context, {
										process: { kind: 'argv', executable: 'probe', args: [] },
										justification:
											'Check configuration supplied to the policy.',
										destination: {
											kind: 'normal',
											id: 'normal',
											label: 'Fixture',
											workspace: {
												root: context.cwd,
												pathFlavor: 'posix',
												relationship: 'shared',
												description: 'Fixture workspace.'
											},
											policyDescription: 'Fixture policy.'
										}
									})
								);
							}
						});
					}
				}
			],
			async (runtime, errors) => {
				await runtime.session.prompt('/configured');
				expect({
					errors,
					decisions,
					configured: validateConfig.mock.calls
				}).toStrictEqual({
					errors: [],
					decisions: [{ kind: 'allow' }],
					configured: [[expected]]
				});
			}
		);
	}
);
