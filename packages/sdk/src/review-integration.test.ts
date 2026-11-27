import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { ScriptedModel } from '../../../test-support/scripted-model.js';

import { createSandboxClient } from './consumer.js';
import type { SandboxNegotiation, ShellReviewSource } from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { UnsupportedSandboxCapabilityError } from './errors.js';
import type { DestinationDescription } from './escalation-ledger.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { registerFixtureProvider } from './fixtures/register-provider.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import { shellBackend } from './fixtures/shell-backend.js';
import sandboxTools from './pi-tools.js';
import { protocolAddress } from './protocol-address.js';
import {
	collectProtocolReplies,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

it('publishes a broker without unbound copy or escalation operations', async () => {
	const replies: unknown[] = [];

	await withPiRuntime(
		[
			{
				name: 'broker-observer',
				factory(pi) {
					createSandboxClient(pi, import.meta.filename);

					pi.on('session_start', () => {
						const broker = ensureSandboxService(pi);
						const local = protocolAddress(pi.events);
						const [reply] = collectProtocolReplies(
							pi.events,
							RUNTIME_CHANNEL,
							local,
							{
								type: 'get-broker'
							}
						);

						replies.push({
							client: Object.keys(broker).toSorted((a, b) =>
								a.localeCompare(b)
							),
							wire: reply?.payload
						});
					});
				}
			}
		],
		(_runtime, errors) => {
			const method = expect.any(Function) as unknown;
			const id = expect.any(String) as unknown;
			const service = {
				acquire: method,
				negotiate: method,
				providers: method,
				resolveReviewSource: method,
				status: method
			};

			expect({ errors, replies }).toStrictEqual({
				errors: [],
				replies: [
					{
						client: Object.keys(service).toSorted((a, b) => a.localeCompare(b)),
						wire: { type: 'broker', id, candidateId: id, service }
					}
				]
			});

			return Promise.resolve();
		}
	);
});

it('refuses a shell command changed after Pi reports the pending call', async () => {
	const { backend, requests } = shellBackend();
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			name: 'bash',
			id: 'changed-command',
			arguments: { command: 'printf original' }
		}
	]);

	await withPiRuntime(
		[
			{
				name: 'provider',
				factory(pi) {
					registerFixtureProvider(pi, '<inline:provider>', {
						id: 'fixture',
						label: 'Fixture',
						profiles: { open: [backend.profile], copy: [] },
						validateConfig: () => ({}),
						open: () => Promise.resolve(backend)
					});
				}
			},
			{
				name: 'shell',
				factory(pi) {
					sandboxTools(pi, '<inline:shell>');
				}
			},
			{
				name: 'edit-command',
				factory(pi) {
					pi.on('tool_call', (event) => {
						if (event.toolName === 'bash') {
							event.input.command = 'printf changed';
						}
					});
				}
			},
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
			await runtime.session.prompt('Run the shell command.');

			const results = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map((message) => message.isError);

			expect({ requests, results, errors }).toStrictEqual({
				requests: [],
				results: [true],
				errors: []
			});
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
			capabilities: [...backend.profile.capabilities]
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
				registerFixtureProvider(pi, '<inline:review-fixture>', {
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
				const reviewer = sdk.createShellReviewClient(pi, '<inline:reviewer>');
				let resolved: ShellReviewSource | undefined;

				if (isAlreadyOpen) {
					const client = sdk.createSandboxClient(pi, '<inline:reviewer>');

					pi.on('session_start', async (_event, context) => {
						await client.get(context);
					});
				}

				pi.on('tool_call', async (event, context) => {
					const result = reviewer.findShellReviewSource(context, event);

					if (!result.ok) {
						throw new Error('The reviewer could not resolve the route.');
					}

					resolved = result.source;

					expect({
						signal: resolved.signal,
						decision: resolved.recordDecision
					}).toStrictEqual({
						signal: undefined,
						decision: undefined
					});

					const negotiation = await resolved.negotiateCopy({
						capabilities: []
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
						policy: copy.sandbox.profile.policy,
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
