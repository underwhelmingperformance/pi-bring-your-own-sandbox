import { expect, it } from 'vitest';

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
