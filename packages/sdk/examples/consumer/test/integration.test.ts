import { realpath } from 'node:fs/promises';

import type {
	ExtensionAPI,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import type {
	ProcessRequest,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/api';
import { afterEach, expect, it, vi } from 'vitest';

import { FixtureConfig } from '../../../src/fixtures/config.js';
import { connectionProvider } from '../../../src/fixtures/connection-provider.js';
import { imageProvider } from '../../../src/fixtures/image-provider.js';
import { messageScenario } from '../../../src/fixtures/message-provider.js';
import { withPiRuntime } from '../../../src/fixtures/pi-runtime.js';
import { contractScenario } from '../../../src/fixtures/provider-contract.js';
import { ScriptedModel } from '../../../src/fixtures/scripted-model.js';
import consumerExtension from '../src/extension.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

function observedProvider<Config>(
	provider: SandboxProvider<Config>,
	{
		calls,
		opening,
		configuration
	}: {
		calls: ProcessRequest[];
		opening: string[];
		configuration: FixtureConfig;
	}
): InlineExtension {
	return {
		name: provider.id,
		factory(pi) {
			configuration.activate(pi, {
				...provider,
				async open(request, context) {
					opening.push(provider.id);

					const backend = await provider.open(request, context);

					return {
						...backend,
						exec: (request, context) => {
							calls.push(request);

							return backend.exec(request, context);
						},
						dispose: (context) => backend.dispose(context)
					};
				}
			});
		}
	};
}

it.each([
	{
		provider: 'passthrough',
		policy: undefined,
		config: undefined,
		target: undefined
	},
	{
		provider: 'fixture.image',
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		},
		config: { image: 'fixture-image' },
		target: '/workspace'
	},
	{
		provider: 'fixture.connection',
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		},
		config: { endpoint: 'https://fixture.invalid' },
		target: '/project'
	},
	...['fixture.memory', 'fixture.message'].map((provider) => ({
		provider,
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		},
		config: {},
		target:
			provider === 'fixture.memory' ? '/remote/project' : '/message/project'
	}))
] as const)('runs the same consumer tool with $provider', async (scenario) => {
	const calls: ProcessRequest[] = [];
	const opening: string[] = [];
	const config = new FixtureConfig();
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'workspace-call',
			name: 'sandbox_pwd',
			arguments: {}
		}
	]);

	await withPiRuntime(
		[
			{ name: 'consumer-example', factory: consumerExtension },
			...[
				observedProvider(imageProvider, {
					calls,
					opening,
					configuration: config
				}),
				observedProvider(connectionProvider, {
					calls,
					opening,
					configuration: config
				}),
				observedProvider(contractScenario().provider, {
					calls,
					opening,
					configuration: config
				}),
				observedProvider(messageScenario().provider, {
					calls,
					opening,
					configuration: config
				})
			].filter((extension) => extension.name === scenario.provider),
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
			await runtime.session.prompt('Inspect the selected workspace.');

			const results = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map((message) => ({
					name: message.toolName,
					isError: message.isError,
					content: message.content
				}));
			const target = scenario.target ?? (await realpath(runtime.services.cwd));

			expect({ errors, opening, calls, results }).toStrictEqual({
				errors: [],
				opening: scenario.provider === 'passthrough' ? [] : [scenario.provider],
				calls:
					scenario.provider === 'passthrough'
						? []
						: [{ kind: 'argv', executable: 'pwd', args: [] }],
				results: [
					{
						name: 'sandbox_pwd',
						isError: false,
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									exit: { kind: 'code', code: 0 },
									stdout: `${target}\n`,
									stderr: '',
									omittedBytes: { stdout: 0, stderr: 0 }
								})
							}
						]
					}
				]
			});
		},
		{
			prepare: (_directory, agentDirectory) => {
				vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

				if (scenario.provider !== 'passthrough') {
					config.set({
						provider: scenario.provider,
						providerConfig: scenario.config,
						policy: scenario.policy
					});
				}
			}
		}
	);
});

it('uses Pi approval before the consumer can acquire or execute', async () => {
	const calls: ProcessRequest[] = [];
	const opening: string[] = [];
	const config = new FixtureConfig();
	const model = new ScriptedModel([
		{
			type: 'toolCall',
			id: 'workspace-call',
			name: 'sandbox_pwd',
			arguments: {}
		}
	]);
	const approver: InlineExtension = {
		name: 'fake-approver',
		factory(pi: ExtensionAPI) {
			pi.on('tool_call', () => ({
				block: true,
				reason: 'Denied by the fake approver.'
			}));
		}
	};

	await withPiRuntime(
		[
			{ name: 'consumer-example', factory: consumerExtension },
			observedProvider(imageProvider, {
				calls,
				opening,
				configuration: config
			}),
			model.extension,
			approver
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
			await runtime.session.prompt('Inspect the selected workspace.');

			const result = model.requests
				.at(1)
				?.messages.filter((message) => message.role === 'toolResult')
				.map((message) => ({
					isError: message.isError,
					content: message.content
				}));

			expect({ errors, opening, calls, result }).toStrictEqual({
				errors: [],
				opening: [],
				calls: [],
				result: [
					{
						isError: true,
						content: [{ type: 'text', text: 'Denied by the fake approver.' }]
					}
				]
			});
		},
		{
			prepare: (_directory, agentDirectory) => {
				vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
				config.set({
					provider: 'fixture.image',
					providerConfig: { image: 'fixture-image' },
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'provider-default'
					}
				});
			}
		}
	);
});
