import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type {
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import {
	closeSandboxSession,
	getSandbox,
	registerSandboxProvider
} from './api.js';
import { discoverBroker } from './discovery.js';
import sandboxExtension from './extension.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { getOutsideSandboxExecutor } from './outside-execution.js';
import sandboxTools from './pi-tools.js';
import { isRecord } from './validation.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

interface Fixture {
	readonly pi: ExtensionAPI;
	readonly context: ExtensionContext;
	readonly runtime: AgentSessionRuntime;
	readonly errors: readonly unknown[];
	readonly backend: MemoryBackend;
	readonly counts: () => { opens: number; disposals: number };
}

async function fixture(
	mode:
		| 'default'
		| 'configured'
		| 'outside'
		| 'startup-failure'
		| 'cleanup-failure'
		| 'invalid-config',
	execute: (fixture: Fixture) => Promise<void>,
	extensions: readonly InlineExtension[] = []
): Promise<void> {
	const secret = 'PRIVATE_PROVIDER_TOKEN';
	const backend = new MemoryBackend();
	let opens = 0;
	let disposals = 0;

	backend.dispose = () => {
		disposals++;

		return mode === 'cleanup-failure'
			? Promise.reject(new Error(secret))
			: Promise.resolve();
	};

	const current: { pi?: ExtensionAPI; context?: ExtensionContext } = {};

	await withPiRuntime(
		[
			{ name: 'framework', factory: sandboxExtension },
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(pi, {
						id: 'fixture',
						label: 'In-memory fixture; no OS isolation.',
						protocolVersion: 1,
						capabilities: backend.capabilities,
						policies: {
							workspaceAccess: ['read-write'],
							filesystemScope: ['provider-default'],
							networkAccess: ['provider-default']
						},
						validateConfig(input: unknown) {
							if (!isRecord(input) || input.token !== secret) {
								throw new Error(secret);
							}

							return { token: secret };
						},
						...(mode === 'outside' && {
							outsideSandbox: {
								label: 'Fixture outside destination',
								capabilities: backend.capabilities,
								policy: backend.policy,
								open() {
									opens++;

									return Promise.resolve(backend);
								}
							}
						}),
						open() {
							opens++;

							return mode === 'startup-failure'
								? Promise.reject(new Error(secret))
								: Promise.resolve(backend);
						}
					});
				}
			},
			...extensions,
			{
				name: 'observer',
				factory(pi) {
					current.pi = pi;
					pi.on('session_start', (_event, context) => {
						current.context = context;
					});
				}
			}
		],
		async (runtime, errors) => {
			const { pi, context } = current;

			if (pi === undefined || context === undefined) {
				throw new Error('Pi did not initialise the diagnostic fixture.');
			}

			await execute({
				pi,
				context,
				runtime,
				errors,
				backend,
				counts: () => ({ opens, disposals })
			});
		},
		{
			includeBuiltins: true,
			async prepare(_directory, agentDirectory) {
				vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);

				if (mode === 'default') {
					return;
				}

				const config =
					mode === 'invalid-config'
						? `{"token":"${secret}",`
						: JSON.stringify({
								provider: 'fixture',
								policy: backend.policy,
								providerConfig: { token: secret },
								...(mode === 'outside' && {
									outsideSandbox: { destination: 'provider' },
									approval: { policy: 'always' }
								})
							});

				await writeFile(path.join(agentDirectory, 'byos.json'), config);
			}
		}
	);
}

function messages(runtime: AgentSessionRuntime) {
	type DiagnosticMessage = Extract<
		AgentSessionRuntime['session']['messages'][number],
		{ role: 'custom' }
	>;

	return runtime.session.messages
		.filter(
			(message): message is DiagnosticMessage =>
				message.role === 'custom' && message.customType === 'byos'
		)
		.map((message) => ({ content: message.content, display: message.display }));
}

it('reports default status in a headless Pi session without opening a backend or changing tools', async () => {
	await fixture('default', async ({ pi, context, runtime, errors, counts }) => {
		const tools = runtime.session.getActiveToolNames();

		await runtime.session.prompt('/byos status');

		const status = await discoverBroker(pi.events)?.status(context);

		if (status === undefined) {
			throw new Error('The framework did not publish a broker.');
		}

		expect({
			errors,
			tools,
			afterTools: runtime.session.getActiveToolNames(),
			responses: messages(runtime).map((message) => ({
				...message,
				content:
					typeof message.content === 'string'
						? message.content.replaceAll(status.generationId, '<generation>')
						: message.content
			})),
			...counts()
		}).toStrictEqual({
			errors: [],
			tools: ['read', 'bash', 'edit', 'write'],
			afterTools: ['read', 'bash', 'edit', 'write'],
			opens: 0,
			disposals: 0,
			responses: [
				{
					display: true,
					content:
						'Provider: passthrough (default)\nState: idle\nGeneration: <generation>\nTarget: not opened\nRequested policy: workspace read-write; filesystem provider-default; network provider-default\nUser shell: provider default (not opened)\nHost execution without isolation.\nApproval policy: user\nOutside execution destination: normal\nOutside native Pi shell termination scope: none\nPi shell integration: not requested; routing unverified.'
				}
			]
		});
	});
});

it('enumerates providers without allocation and omits provider configuration', async () => {
	await fixture('configured', async ({ runtime, errors, counts }) => {
		await runtime.session.prompt('/byos providers');
		expect({ errors, ...counts(), responses: messages(runtime) }).toStrictEqual(
			{
				errors: [],
				opens: 0,
				disposals: 0,
				responses: [
					{
						display: true,
						content:
							'Available sandbox providers (declared capabilities):\npassthrough: Host execution without isolation\n  Operations: exec, files.read, files.write, files.list, search.find, search.grep\n  Termination scope: process-group\n  Shells: bash, sh, powershell\n  Policies: workspace read-write; filesystem provider-default; network provider-default\nfixture: In-memory fixture; no OS isolation.\n  Operations: exec, files.read, files.write, files.list\n  Termination scope: workload\n  Shells: none\n  Policies: workspace read-write; filesystem provider-default; network provider-default'
					}
				]
			}
		);
	});
});

it('reports the target and effective policy after acquisition', async () => {
	await fixture(
		'configured',
		async ({ pi, context, runtime, errors, counts }) => {
			const sandbox = await getSandbox(pi, context);

			await runtime.session.prompt('/byos');

			const output = messages(runtime).map((message) => ({
				...message,
				content:
					typeof message.content === 'string'
						? message.content.replaceAll(sandbox.generationId, '<generation>')
						: message.content
			}));

			expect({ errors, ...counts(), output }).toStrictEqual({
				errors: [],
				opens: 1,
				disposals: 0,
				output: [
					{
						display: true,
						content:
							'Provider: fixture (personal)\nState: ready\nGeneration: <generation>\nBackend: memory\nTarget: /remote/project (remote)\nEffective policy: workspace read-write; filesystem provider-default; network provider-default\nOperations: exec, files.read, files.write, files.list\nTermination scope: workload\nShells: none\nUser shell: unavailable\nBoundary: In-memory test fixture; no OS isolation.\nApproval policy: user\nOutside execution destination: normal\nOutside native Pi shell termination scope: none\nPi shell integration: not requested; routing unverified.'
					}
				]
			});
		}
	);
});

it('keeps provider enumeration available after startup fails and excludes raw error causes', async () => {
	await fixture(
		'startup-failure',
		async ({ pi, context, runtime, errors, counts }) => {
			await expect(getSandbox(pi, context)).rejects.toMatchObject({
				name: 'SandboxStartupError'
			});
			await runtime.session.prompt('/byos providers');
			await runtime.session.prompt('/byos status');

			const output = JSON.stringify(messages(runtime));

			expect({
				errors,
				...counts(),
				hasProviders: output.includes('Available sandbox providers'),
				hasFailure: output.includes('SandboxStartupError'),
				leaksSecret: output.includes('PRIVATE_PROVIDER_TOKEN')
			}).toStrictEqual({
				errors: [],
				opens: 1,
				disposals: 0,
				hasProviders: true,
				hasFailure: true,
				leaksSecret: false
			});
		}
	);
});

it('reports incomplete cleanup without exposing raw disposal errors', async () => {
	await fixture('cleanup-failure', async ({ pi, context, runtime, counts }) => {
		await getSandbox(pi, context);
		await closeSandboxSession(pi, context);
		await runtime.session.prompt('/byos status');

		const output = JSON.stringify(messages(runtime));

		expect({
			...counts(),
			hasClosedState: output.includes('State: closed'),
			hasIncompleteCleanup: output.includes('Cleanup: incomplete'),
			hasCleanupError: output.includes('SandboxCleanupError'),
			leaksSecret: output.includes('PRIVATE_PROVIDER_TOKEN')
		}).toStrictEqual({
			opens: 1,
			disposals: 1,
			hasClosedState: true,
			hasIncompleteCleanup: true,
			hasCleanupError: true,
			leaksSecret: false
		});
	});
});

it('remains usable after Pi records an initial configuration error', async () => {
	await fixture('invalid-config', async ({ runtime, errors, counts }) => {
		await runtime.session.prompt('/byos status');

		const output = JSON.stringify(messages(runtime));

		expect({
			...counts(),
			hasInitialError: errors.length > 0,
			hasFailedState: output.includes('State: failed'),
			hasConfigurationError: output.includes('InvalidSandboxConfigError'),
			leaksSecret: output.includes('PRIVATE_PROVIDER_TOKEN')
		}).toStrictEqual({
			opens: 0,
			disposals: 0,
			hasInitialError: true,
			hasFailedState: true,
			hasConfigurationError: true,
			leaksSecret: false
		});
	});
});

it('prints command usage without starting a model turn', async () => {
	await fixture('default', async ({ runtime, counts }) => {
		await runtime.session.prompt('/byos unknown');
		expect({ ...counts(), output: messages(runtime) }).toStrictEqual({
			opens: 0,
			disposals: 0,
			output: [
				{
					display: true,
					content:
						'Usage: /byos status | /byos providers | /byos approval-policies'
				}
			]
		});
	});
});

it('reports requested shell integration without claiming verified interception', async () => {
	await fixture(
		'default',
		async ({ runtime, errors, counts }) => {
			const tools = runtime.session.getActiveToolNames();

			await runtime.session.prompt('/byos status');

			const lines = messages(runtime).flatMap((message) =>
				typeof message.content === 'string'
					? message.content
							.split('\n')
							.filter((line) => line.startsWith('Pi shell integration:'))
					: []
			);

			expect({
				errors,
				...counts(),
				tools: runtime.session.getActiveToolNames(),
				lines
			}).toStrictEqual({
				errors: [],
				opens: 0,
				disposals: 0,
				tools,
				lines: ['Pi shell integration: requested; routing unverified.']
			});
		},
		[{ name: 'shell-integration', factory: sandboxTools }]
	);
});

it('enumerates built-in approval policies without allocating a backend', async () => {
	await fixture('default', async ({ runtime, errors, counts }) => {
		await runtime.session.prompt('/byos approval-policies');
		expect({ errors, ...counts(), responses: messages(runtime) }).toStrictEqual(
			{
				errors: [],
				opens: 0,
				disposals: 0,
				responses: [
					{
						display: true,
						content:
							'Available execution approval policies:\nuser: user\nalways: always\nnever: never'
					}
				]
			}
		);
	});
});

it('shows provider warnings through generic status without adding workload output', async () => {
	await fixture(
		'configured',
		async ({ pi, context, runtime, backend, errors }) => {
			backend.exec = (_request, execution) => {
				execution.reportDiagnostic({
					level: 'warning',
					message: 'Provider runtime warning'
				});
				execution.onOutput({
					stream: 'stdout',
					data: new TextEncoder().encode('workload')
				});

				return Promise.resolve({
					kind: 'exited',
					exit: { kind: 'code', code: 0 }
				});
			};

			const sandbox = await getSandbox(pi, context);
			const result = await sandbox.exec({
				kind: 'argv',
				executable: 'probe',
				args: []
			});

			await runtime.session.prompt('/byos status');

			const content = messages(runtime)
				.flatMap((message) =>
					typeof message.content === 'string' ? message.content : []
				)
				.join('\n');
			const status = await discoverBroker(pi.events)?.status(context);

			expect({
				output: new TextDecoder().decode(result.stdout),
				errors
			}).toStrictEqual({ output: 'workload', errors: [] });

			const operationId: unknown = expect.any(String);

			expect(status?.diagnostics).toStrictEqual([
				{
					level: 'warning',
					message: 'Provider runtime warning',
					operation: 'exec',
					operationId,
					providerId: 'fixture',
					backendId: backend.id
				}
			]);
			expect(content).toContain('Provider runtime warning');
			expect(content).not.toContain('\nworkload\n');
		}
	);
});

it('shows outside-provider warnings without opening the ordinary sandbox', async () => {
	await fixture(
		'outside',
		async ({ pi, context, runtime, backend, errors, counts }) => {
			backend.exec = (_request, execution) => {
				execution.reportDiagnostic({
					level: 'warning',
					message: 'Outside runtime warning'
				});
				execution.onOutput({
					stream: 'stdout',
					data: new TextEncoder().encode('outside workload')
				});

				return Promise.resolve({
					kind: 'exited',
					exit: { kind: 'code', code: 0 }
				});
			};

			const executor = await getOutsideSandboxExecutor(pi, context);
			const result = await executor.exec(
				{ kind: 'argv', executable: 'probe', args: [] },
				{ justification: 'Inspect outside diagnostics.' }
			);

			await runtime.session.prompt('/byos status');

			const content = messages(runtime)
				.flatMap((message) =>
					typeof message.content === 'string' ? message.content : []
				)
				.join('\n');

			expect({
				output: new TextDecoder().decode(result.stdout),
				errors,
				...counts()
			}).toStrictEqual({
				output: 'outside workload',
				errors: [],
				opens: 1,
				disposals: 0
			});
			expect(content).toContain('Outside execution diagnostics:');
			expect(content).toContain('Outside runtime warning');
			expect(content).not.toContain('outside workload');
		}
	);
});
