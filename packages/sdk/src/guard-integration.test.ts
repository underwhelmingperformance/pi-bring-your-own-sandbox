import type {
	ExtensionAPI,
	ExtensionContext,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import {
	configureExecutionApproval,
	getOutsideSandboxExecutor,
	getSandbox,
	negotiateSandbox,
	registerSandboxProvider,
	registerSandboxRequirement
} from './api.js';
import type {
	SandboxCapability,
	SandboxOpenRequest,
	SandboxPolicy,
	SandboxProvider,
	SandboxRequirements
} from './contracts.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { ScriptedModel } from './fixtures/scripted-model.js';
import { loadSdkInstance } from './fixtures/sdk-instance.js';
import { passthroughProvider } from './passthrough-provider.js';
import sandboxTools from './pi-tools.js';

async function scenario(
	extensions: readonly InlineExtension[],
	run: (pi: ExtensionAPI, context: ExtensionContext) => Promise<void>
) {
	const state: { pi?: ExtensionAPI; context?: ExtensionContext } = {};

	await withPiRuntime(
		[
			...extensions,
			{
				name: 'consumer',
				factory(pi) {
					state.pi = pi;
					pi.on('session_start', (_event, context) => {
						state.context = context;
					});
				}
			}
		],
		async (runtime, errors) => {
			expect(
				runtime.services.resourceLoader.getExtensions().errors
			).toStrictEqual([]);

			if (state.pi === undefined || state.context === undefined) {
				throw new Error('Pi did not initialise the consumer context.');
			}

			await run(state.pi, state.context);
			expect(errors).toStrictEqual([]);
		}
	);
}

class PolicyBackend extends MemoryBackend {
	override readonly policy: SandboxPolicy;

	constructor(policy: SandboxPolicy) {
		super();
		this.policy = policy;
	}
}

function guard(requirements: SandboxRequirements = {}): InlineExtension {
	return {
		name: 'guard',
		factory(pi) {
			registerSandboxRequirement(pi, requirements);
		}
	};
}

function provider(backend = new MemoryBackend()): SandboxProvider<object> {
	return {
		id: 'fixture',
		label: 'Fake sandbox',
		protocolVersion: 1,
		capabilities: backend.capabilities,
		defaultPolicy: backend.policy,
		policies: {
			workspaceAccess: ['read-write', 'read-only'],
			filesystemScope: ['provider-default', 'system-read-only'],
			networkAccess: ['provider-default', 'denied']
		},
		validateConfig: () => ({}),
		open: () => Promise.resolve(backend)
	};
}

it('blocks ordinary and outside acquisition when the required extension is missing', async () => {
	await scenario([guard()], async (pi, context) => {
		await expect(negotiateSandbox(pi, context)).resolves.toMatchObject({
			ok: false,
			error: { name: 'SandboxProviderRequiredError' }
		});

		await expect(getSandbox(pi, context)).rejects.toMatchObject({
			name: 'SandboxProviderRequiredError'
		});
		await expect(getOutsideSandboxExecutor(pi, context)).rejects.toMatchObject({
			name: 'SandboxProviderRequiredError'
		});
	});
});

it.each(['guard-first', 'provider-first'] as const)(
	'accepts explicit activation in %s factory order',
	async (order) => {
		const backend = new MemoryBackend();
		const active: InlineExtension = {
			name: 'provider',
			factory(pi) {
				registerSandboxProvider(pi, provider(backend));
			}
		};

		await scenario(
			order === 'guard-first'
				? [
						guard({ providerId: 'fixture', capabilities: ['files.read'] }),
						active
					]
				: [
						active,
						guard({ providerId: 'fixture', capabilities: ['files.read'] })
					],
			async (pi, context) => {
				const sandbox = await getSandbox(pi, context);

				await sandbox.files.writeFile(
					'message',
					new TextEncoder().encode('hello')
				);

				const result = await sandbox.files.readFile('message');

				expect({
					provider: sandbox.providerId,
					text: new TextDecoder().decode(result)
				}).toStrictEqual({ provider: 'fixture', text: 'hello' });
			}
		);
	}
);

it.each([
	{
		requirements: { providerId: 'other' },
		error: 'SandboxProviderMismatchError'
	},
	{
		requirements: { capabilities: ['search.grep'] },
		error: 'UnsupportedSandboxCapabilityError'
	},
	{
		requirements: { processKinds: ['shell'] },
		error: 'UnsupportedSandboxCapabilityError'
	},
	{
		requirements: { shells: ['bash'] },
		error: 'UnsupportedSandboxCapabilityError'
	},
	{
		requirements: { policy: { filesystemScope: 'workspace-only' } },
		error: 'UnsupportedSandboxPolicyError'
	}
] as const)(
	'rejects an unsatisfied guard before allocation: $requirements',
	async ({ requirements, error }) => {
		const backend = new MemoryBackend();
		const open = vi.fn(() => Promise.resolve(backend));
		const configure = vi.fn(() => ({ configuration: {} }));

		await scenario(
			[
				guard(requirements),
				{
					name: 'provider',
					factory(pi) {
						registerSandboxProvider(
							pi,
							{ ...provider(backend), open },
							{ configure }
						);
					}
				}
			],
			async (pi, context) => {
				await expect(getSandbox(pi, context)).rejects.toMatchObject({
					name: error
				});
				await expect(
					getOutsideSandboxExecutor(pi, context)
				).rejects.toMatchObject({ name: error });
				expect(open.mock.calls).toStrictEqual([]);
			}
		);
	}
);

it('combines guard policies and rejects a consumer request that loosens them', async () => {
	const backend = new MemoryBackend();
	const declaration = provider(backend);
	const open = vi.fn((request: SandboxOpenRequest<object>) =>
		Promise.resolve(new PolicyBackend(request.policy))
	);

	await scenario(
		[
			guard({ policy: { workspaceAccess: 'read-only' } }),
			guard({ policy: { networkAccess: 'denied' } }),
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, { ...declaration, open });
				}
			}
		],
		async (pi, context) => {
			const sandbox = await getSandbox(pi, context);

			expect(sandbox.policy).toStrictEqual({
				...backend.policy,
				workspaceAccess: 'read-only',
				networkAccess: 'denied'
			});
			await expect(
				getSandbox(pi, context, { policy: { workspaceAccess: 'read-write' } })
			).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
			expect(open.mock.calls).toHaveLength(1);
		}
	);
});

it('checks guard requirements against the opened backend', async () => {
	const backend = new MemoryBackend('exec');

	await scenario(
		[
			guard({ capabilities: ['files.read'] }),
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, {
						...provider(backend),
						capabilities: new MemoryBackend().capabilities
					});
				}
			}
		],
		async (pi, context) => {
			await expect(getSandbox(pi, context)).rejects.toMatchObject({
				name: 'UnsupportedSandboxCapabilityError'
			});
		}
	);
});

it('allows approved outside execution without opening an ordinary sandbox', async () => {
	const backend = new MemoryBackend('exec');
	const open = vi.fn(() => Promise.resolve(backend));

	await scenario(
		[
			guard({ providerId: 'fixture' }),
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, { ...provider(backend), open });
					configureExecutionApproval(pi, () => ({ policy: 'always' }));
				}
			}
		],
		async (pi, context) => {
			const outside = await getOutsideSandboxExecutor(pi, context);
			const result = await outside.exec(
				{
					kind: 'argv',
					executable: process.execPath,
					args: ['-e', 'process.stdout.write("hello")']
				},
				{ justification: 'Exercise approved outside execution.' }
			);

			expect({
				exit: result.exit,
				output: new TextDecoder().decode(result.stdout),
				openings: open.mock.calls
			}).toStrictEqual({
				exit: { kind: 'code', code: 0 },
				output: 'hello',
				openings: []
			});
		}
	);
});

it.each([
	{
		requirements: { terminationScope: 'workload' },
		capabilities: { terminationScope: 'none' }
	},
	{
		requirements: { exitStatus: 'guaranteed' },
		capabilities: { exitStatus: 'optional' }
	}
] as const)(
	'checks declared cleanup and exit guarantees before outside execution: $requirements',
	async ({ requirements, capabilities }) => {
		const backend = new MemoryBackend('exec');
		const open = vi.fn(() => Promise.resolve(backend));

		await scenario(
			[
				guard(requirements),
				{
					name: 'provider',
					factory(pi) {
						registerSandboxProvider(pi, {
							...provider(backend),
							capabilities: { ...backend.capabilities, ...capabilities },
							open
						});
					}
				}
			],
			async (pi, context) => {
				await expect(
					getOutsideSandboxExecutor(pi, context)
				).rejects.toMatchObject({ name: 'UnsupportedSandboxCapabilityError' });
				expect(open.mock.calls).toStrictEqual([]);
			}
		);
	}
);

it('applies requirements across independently loaded SDK copies', async () => {
	const peer = await loadSdkInstance();
	const backend = new MemoryBackend();

	await scenario(
		[
			{
				name: 'independent-guard',
				factory(pi) {
					peer.registerSandboxRequirement(pi, {
						providerId: 'fixture',
						capabilities: ['files.read']
					});
				}
			},
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, provider(backend));
				}
			}
		],
		async (pi, context) => {
			const [first, second] = await Promise.all([
				getSandbox(pi, context),
				peer.getSandbox(pi, context)
			]);

			expect({
				providers: [first.providerId, second.providerId],
				generations: first.generationId === second.generationId
			}).toStrictEqual({
				providers: ['fixture', 'fixture'],
				generations: true
			});
		}
	);
});

it('accepts an explicitly activated host implementation through the same requirements', async () => {
	await scenario(
		[
			guard(),
			{
				name: 'explicit-host',
				factory(pi) {
					const {
						configure: _configure,
						outsideSandbox: _outside,
						...info
					} = passthroughProvider;

					registerSandboxProvider(pi, {
						...info,
						id: 'explicit.host',
						protocolVersion: 1,
						validateConfig: () => ({}),
						open: (request, scope) =>
							passthroughProvider.configure({}).open(request, scope)
					});
				}
			}
		],
		async (pi, context) => {
			const sandbox = await getSandbox(pi, context);

			expect({
				provider: sandbox.providerId,
				policy: sandbox.policy
			}).toStrictEqual({
				provider: 'explicit.host',
				policy: passthroughProvider.defaultPolicy
			});
		}
	);
});

it('snapshots requirements and rejects changes after acquisition', async () => {
	const requirements: {
		providerId: string;
		capabilities: SandboxCapability[];
	} = { providerId: 'fixture', capabilities: ['files.read'] };

	await scenario(
		[
			{
				name: 'guard',
				factory(pi) {
					registerSandboxRequirement(pi, requirements);
					requirements.providerId = 'changed';
					requirements.capabilities.push('search.grep');
				}
			},
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, provider());
				}
			}
		],
		async (pi, context) => {
			const sandbox = await getSandbox(pi, context);

			expect(sandbox.providerId).toBe('fixture');
			expect(() => {
				registerSandboxRequirement(pi);
			}).toThrow(
				expect.objectContaining({ name: 'InvalidSandboxRequestError' })
			);
		}
	);
});

it('rejects conflicting expected provider identities', async () => {
	await scenario(
		[
			guard({ providerId: 'fixture' }),
			guard({ providerId: 'other' }),
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, provider());
				}
			}
		],
		async (pi, context) => {
			await expect(getSandbox(pi, context)).rejects.toMatchObject({
				name: 'SandboxProviderMismatchError'
			});
		}
	);
});

it.each(['sandbox', 'outside-sandbox'] as const)(
	'blocks Pi shell tool dispatch through the SDK: %s',
	async (execution) => {
		const model = new ScriptedModel([
			{
				type: 'toolCall',
				id: 'guarded',
				name: 'bash',
				arguments: {
					command: 'printf forbidden',
					execution,
					...(execution === 'outside-sandbox' && {
						justification: 'Exercise the guard.'
					})
				}
			}
		]);

		await withPiRuntime(
			[
				guard(),
				{ name: 'shell-tools', factory: sandboxTools },
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
				await runtime.session.prompt('Exercise guarded execution.');

				const results = model.requests
					.at(1)
					?.messages.filter((message) => message.role === 'toolResult')
					.map((message) => ({
						isError: message.isError,
						content: message.content
					}));

				expect({ errors, results }).toStrictEqual({
					errors: [],
					results: [
						{
							isError: true,
							content: [
								{
									type: 'text',
									text: 'A sandbox provider must be activated. Load the required provider extension.'
								}
							]
						}
					]
				});
			},
			{ tools: ['bash'] }
		);
	}
);
