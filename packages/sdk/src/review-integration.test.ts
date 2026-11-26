import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import type {
	DestinationDescription,
	SandboxNegotiation,
	ShellReviewSource
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { UnsupportedSandboxCapabilityError } from './errors.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import { shellBackend } from './fixtures/shell-backend.js';
import sandboxTools from './pi-tools.js';
import { registerSandboxProvider } from './provider-registration.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

it('rejects review registration with extension callbacks before issuing an identity', async () => {
	const callback = vi.fn();
	const attempts: string[] = [];

	await withPiRuntime(
		[
			{
				name: 'forged-route',
				factory(pi) {
					pi.on('session_start', async (_event, context) => {
						const broker = ensureSandboxService(pi);

						if (broker.prepareReview === undefined) {
							throw new Error(
								'The broker did not publish review registration.'
							);
						}

						await expect(
							broker.prepareReview(context, {
								call: { toolName: 'bash', toolCallId: 'forged-call' },
								isCurrent: callback,
								markReviewed: callback,
								recordDecision: callback
							})
						).rejects.toMatchObject({
							name: 'InvalidSandboxRequestError',
							detail: { kind: 'request', field: 'review' }
						});
						attempts.push('rejected');

						const call = { toolName: 'bash', toolCallId: 'unobserved-call' };
						const registration = await broker.prepareReview(context, { call });
						const sourceId = registration.issue({
							...call,
							sessionId: context.sessionManager.getSessionId(),
							requestId: 'query-without-a-call',
							extensionSource: '<inline:forged-route>'
						});

						expect(sourceId).toBeUndefined();
						registration.revoke();
					});
				}
			}
		],
		(_runtime, errors) => {
			expect({
				errors,
				attempts,
				invocations: callback.mock.calls
			}).toStrictEqual({
				errors: [],
				attempts: ['rejected'],
				invocations: []
			});

			return Promise.resolve();
		}
	);
});

it.each([false, true])(
	'resolves and negotiates a private review copy through another SDK without opening a destination (already open: %s)',
	async (isAlreadyOpen) => {
		const sdk = await loadSdkInstance();
		const { backend, requests } = shellBackend();
		const opens: string[] = [];
		const copies: string[] = [];
		const disposals: string[] = [];
		const location = { ...backend.workspace, relationship: 'copied' as const };
		const openProfile = {
			...backend.profile,
			capabilities: [...backend.profile.capabilities, 'copy' as const]
		};
		const copyProfile = {
			...backend.profile,
			policy: { ...backend.profile.policy, hostWorkspaceWrites: false }
		};
		const checks: {
			readonly destination: DestinationDescription;
			readonly negotiation: SandboxNegotiation;
			readonly opens: readonly string[];
			readonly copies: readonly string[];
		}[] = [];
		const provider: InlineExtension = {
			name: 'review-fixture',
			factory(pi) {
				registerSandboxProvider(pi, '<inline:review-fixture>', {
					id: 'fixture.review',
					label: 'Review fixture',
					profiles: { open: [openProfile], copy: [copyProfile] },
					validateConfig: () => ({}),
					open(request) {
						opens.push(backend.id);

						return Promise.resolve({ ...backend, profile: request.profile });
					},
					copy(request) {
						copies.push(
							request.source.kind === 'backend'
								? request.source.backend.id
								: 'host'
						);

						return Promise.resolve({
							...backend,
							id: 'copy',
							profile: request.profile,
							workspace: location,
							dispose() {
								disposals.push('copy');

								return Promise.resolve();
							}
						});
					}
				});
			}
		};
		const callId = 'review-copy';
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				name: 'bash',
				id: callId,
				arguments: { command: 'printf target' }
			}
		]);
		const reviewer: InlineExtension = {
			name: 'reviewer',
			factory(pi) {
				const client = sdk.createSandboxClient(pi, '<inline:reviewer>');
				let resolved: ShellReviewSource | undefined;

				if (isAlreadyOpen) {
					pi.on('session_start', async (_event, context) => {
						await client.get(context);
					});
				}

				pi.on('tool_call', async (event, context) => {
					const result = client.findShellReviewSource(context, event);

					if (!result.ok) {
						throw new Error('The reviewer could not resolve the route.');
					}

					resolved = result.source;

					const negotiation = await resolved.negotiateCopy({
						capabilities: ['exec']
					});

					checks.push({
						destination: resolved.destination,
						negotiation,
						opens: [...opens],
						copies: [...copies]
					});

					const unsupported = await resolved.negotiateCopy({
						capabilities: ['files.write']
					});

					if (unsupported.ok) {
						throw new Error('The copy profile has no file writer.');
					}

					expect({
						name: unsupported.error.name,
						detail: unsupported.error.detail
					}).toStrictEqual({
						name: UnsupportedSandboxCapabilityError.errorName,
						detail: {
							kind: 'capability',
							field: 'capabilities',
							value: 'files.write'
						}
					});

					const copy = await resolved.copy();

					expect({
						workspace: copy.sandbox.workspace,
						policy: copy.sandbox.policy,
						report: await copy.close()
					}).toStrictEqual({
						workspace: location,
						policy: copyProfile.policy,
						report: { confirmed: true, recoveries: [], failures: [] }
					});
				});
				pi.on('tool_result', async () => {
					if (resolved === undefined) {
						throw new Error('The fixture did not retain the review source.');
					}

					await expect(resolved.copy()).rejects.toMatchObject({
						name: 'StaleSandboxHandleError'
					});
				});
			}
		};

		await withPiRuntime(
			[
				provider,
				{
					name: 'shell',
					factory(pi) {
						sandboxTools(pi, '<inline:shell>');
					}
				},
				reviewer,
				model.extension
			],
			async (runtime, errors) => {
				const selected = runtime.session.modelRuntime.getModel(
					'scripted',
					'scripted'
				);

				if (selected === undefined) {
					throw new Error('The scripted model was not registered.');
				}

				await runtime.session.setModel(selected);
				runtime.session.setActiveToolsByName(['bash']);
				await runtime.session.prompt('Run the reviewed shell command.');

				const ledger = runtime.session.sessionManager
					.getEntries()
					.flatMap((entry) =>
						entry.type === 'custom' && entry.customType === 'byos.ledger'
							? [entry.data]
							: []
					);
				const destination = {
					providerId: 'fixture.review',
					label: 'Review fixture',
					policy: openProfile.policy,
					...(isAlreadyOpen && { workspace: backend.workspace })
				};

				expect({
					errors,
					checks,
					opens,
					copies,
					disposals,
					requests,
					ledger
				}).toStrictEqual({
					errors: [],
					checks: [
						{
							destination,
							negotiation: { ok: true, profile: copyProfile },
							opens: isAlreadyOpen ? [backend.id] : [],
							copies: []
						}
					],
					opens: [backend.id],
					copies: [isAlreadyOpen ? backend.id : 'host'],
					disposals: ['copy'],
					requests: [
						{
							kind: 'shell',
							dialect: 'bash',
							command: 'printf target',
							cwd: backend.workspace.root
						}
					],
					ledger: [
						{
							kind: 'review-copy',
							toolCallId: callId,
							source: destination,
							policy: copyProfile.policy,
							decider: {
								kind: 'permission-extension',
								extension: '<inline:reviewer>'
							}
						}
					]
				});
			},
			{
				prepare(_directory, agentDirectory) {
					vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
				}
			}
		);
	}
);
