import type {
	AgentSessionRuntime,
	ExtensionAPI,
	ExtensionContext,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { registerSandboxProvider } from './api.js';
import { closeSandboxSession } from './api.js';
import { registerSandboxDiagnostics as sandboxExtension } from './diagnostic-registration.js';
import { discoverBroker } from './discovery.js';
import type { SandboxLedgerEntry } from './escalation-ledger.js';
import { appendLedgerEntry } from './escalation-ledger.js';
import { FixtureConfig } from './fixtures/config.js';
import { getSandbox } from './fixtures/fixture-client.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { fixtureProfiles } from './fixtures/profile-fixture.js';
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

	const config = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'framework',
				factory(pi) {
					sandboxExtension(pi, import.meta.filename);
				}
			},
			{
				name: 'provider',
				factory(pi) {
					if (mode === 'default') {
						return;
					}

					config.activate(pi, {
						id: 'fixture',
						label: 'In-memory fixture; no OS isolation.',
						profiles: fixtureProfiles(backend.capabilities, {
							hostWorkspaceWrites: [true],
							hostUserData: ['denied'],
							hostSystemFiles: ['read-only'],
							network: [false]
						}),

						validateConfig(input: unknown) {
							if (!isRecord(input) || input['token'] !== secret) {
								throw new Error(secret);
							}

							return { token: secret };
						},

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
			prepare(_directory, agentDirectory) {
				vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
				config.set(
					mode === 'invalid-config'
						? 'invalid'
						: {
								providerConfig: { token: secret },
								policy: backend.policy
							}
				);
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
						? message.content
								.replaceAll(status.generationId, '<generation>')
								.replace(/SDK build: [^\n]+/u, 'SDK build: <build>')
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
						'Provider: passthrough (default)\nState: idle\nGeneration: <generation>\nSDK build: <build>\nProtocol: major 1, feature level 0\nTarget: not opened\nRequested policy: workspace read-write, network allowed, host user data read-write, host system files read-write\nUser shell: provider default (not opened)\nProvider description: Host execution without isolation\nPi shell integration: not requested; routing unverified.'
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
							'Available sandbox providers (declared profiles)\npassthrough: Host execution without isolation\n  open: workspace read-write (shared), network allowed, host user data read-write, host system files read-write\n    Operations: exec, files.read, files.write, files.list, search.find, search.grep\n    Termination scope: process-group\n    Shells: bash, sh\nfixture: In-memory fixture; no OS isolation.\n  open: workspace read-write (shared), network denied, host user data denied, host system files read-only\n    Operations: exec, files.read, files.write, files.list\n    Termination scope: workload\n    Shells: none'
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
						? message.content
								.replaceAll(sandbox.generationId, '<generation>')
								.replace(/SDK build: [^\n]+/u, 'SDK build: <build>')
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
							'Provider: fixture (extension)\nState: ready\nGeneration: <generation>\nSDK build: <build>\nProtocol: major 1, feature level 0\nBackend: memory\nTarget: /remote/project (shared)\nEffective policy: workspace read-write (shared), network denied, host user data denied, host system files read-only\nOperations: exec, files.read, files.write, files.list\nTermination scope: workload\nShells: none\nUser shell: unavailable\nProvider description: In-memory fixture; no OS isolation.\nBoundary: In-memory test fixture; no OS isolation.\nPi shell integration: not requested; routing unverified.'
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
						'Usage: /byos status | /byos providers | /byos log [tool-call-id]'
				}
			]
		});
	});
});

it('filters the current session ledger by tool call and escapes display controls', async () => {
	const entry: SandboxLedgerEntry = {
		kind: 'escalation',
		request: {
			toolCallId: 'selected',
			command: 'echo \u{202E}hello',
			justification: 'Read the record.',
			access: { network: 'needed' }
		},
		outcome: 'denied',
		decider: { kind: 'configuration' }
	};

	await fixture('default', async ({ runtime, pi, errors, counts }) => {
		appendLedgerEntry(pi, {
			...entry,
			request: { ...entry.request, toolCallId: 'other' }
		});
		appendLedgerEntry(pi, entry);
		await runtime.session.prompt('/byos log selected');

		expect({ ...counts(), errors, output: messages(runtime) }).toStrictEqual({
			opens: 0,
			disposals: 0,
			errors: [],
			output: [
				{
					display: true,
					content: JSON.stringify(entry).replace(
						'\u{202E}',
						String.raw`\u{202e}`
					)
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

it('displays resolver diagnostics after configuration fails without exposing its cause', async () => {
	const backend = new MemoryBackend();
	const open = vi.fn(() => Promise.resolve(backend));

	await withPiRuntime(
		[
			{
				name: 'diagnostics',
				factory(pi) {
					sandboxExtension(pi, import.meta.filename);
				}
			},
			{
				name: 'provider',
				factory(pi) {
					registerSandboxProvider(
						pi,
						import.meta.filename,
						{
							id: 'configuration-fixture',
							label: 'Configuration fixture',
							profiles: fixtureProfiles(backend.capabilities, {
								hostWorkspaceWrites: [true],
								hostUserData: ['denied'],
								hostSystemFiles: ['read-only'],
								network: [false]
							}),

							validateConfig: () => ({}),
							open
						},
						{
							configure(scope) {
								scope.reportDiagnostic({
									level: 'warning',
									message: 'sandbox-settings.json: runtime must be a string.'
								});

								throw new Error('PRIVATE_CONFIGURATION_VALUE');
							}
						}
					);
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/byos status');

			const output = JSON.stringify(messages(runtime));

			expect({
				hasStartupError: errors.length > 0,
				hasFailure: output.includes('InvalidSandboxConfigError'),
				hasDiagnostic: output.includes(
					'sandbox-settings.json: runtime must be a string.'
				),
				leaksCause: output.includes('PRIVATE_CONFIGURATION_VALUE'),
				openings: open.mock.calls
			}).toStrictEqual({
				hasStartupError: true,
				hasFailure: true,
				hasDiagnostic: true,
				leaksCause: false,
				openings: []
			});
		}
	);
});
