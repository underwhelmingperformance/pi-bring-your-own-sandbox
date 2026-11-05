import { randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import path from 'node:path';

import type {
	AgentSessionRuntime,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import type {
	Sandbox,
	SandboxBackend,
	SandboxContext,
	SandboxHost,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/api';
import * as sandboxClient from 'pi-bring-your-own-sandbox/api';
import { closeSandboxSession, getSandbox } from 'pi-bring-your-own-sandbox/api';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FixtureConfig } from '../../../src/fixtures/config.js';
import { withPiRuntime } from '../../../src/fixtures/pi-runtime.js';
import { ScriptedModel } from '../../../src/fixtures/scripted-model.js';
import sandboxTools from '../../../src/pi-tools.js';
import { snapshotProcessRequest } from '../../../src/process-input.js';
import { inspectWorkspace } from '../../consumer/src/workspace.js';
import { createDockerProvider } from '../src/provider.js';

import {
	cancellationRequest,
	DockerFixture,
	operationContext
} from './fixture.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

interface DockerSession {
	readonly runtime: AgentSessionRuntime;
	readonly sandbox: Sandbox;
	readonly pi: SandboxHost;
	readonly context: SandboxContext;
	readonly fixture: DockerFixture;
}

async function withDockerSession(
	run: (session: DockerSession) => Promise<void>,
	extensions: readonly InlineExtension[] = [],
	filesystemScope: SandboxPolicy['filesystemScope'] = 'workspace-only'
): Promise<void> {
	let fixture: DockerFixture | undefined;
	const current: { pi?: SandboxHost; context?: SandboxContext } = {};

	try {
		const config = new FixtureConfig();

		await withPiRuntime(
			[
				{
					name: 'docker-sdk-fixture',
					factory(pi) {
						if (fixture === undefined) {
							throw new Error('The Docker workspace was not prepared.');
						}

						const prepared = fixture;

						config.activate(
							pi,
							createDockerProvider(() => prepared.providerClient())
						);
						current.pi = pi;
						pi.on('session_start', (_event, context) => {
							current.context = context;
						});
					}
				},
				...extensions,
				{
					name: 'execution-settings',
					factory: (pi) => {
						config.bind(pi);
					}
				}
			],
			async (runtime, errors) => {
				const { pi, context } = current;

				if (
					pi === undefined ||
					context === undefined ||
					fixture === undefined
				) {
					throw new Error('Pi did not initialise the Docker fixture.');
				}

				const sandbox = await getSandbox(pi, context);

				try {
					await run({ sandbox, fixture, pi, context, runtime });
				} finally {
					expect(await closeSandboxSession(pi, context)).toStrictEqual({
						confirmed: true,
						failures: [],
						recoveries: []
					});
				}

				expect(errors).toStrictEqual([]);
				await fixture.verifyDisposed();
			},
			{
				prepare: async (directory, agentDirectory) => {
					fixture = await DockerFixture.create(directory);
					vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
					config.set({
						provider: 'example.docker',
						providerConfig: fixture.config,
						policy: {
							workspaceAccess: 'read-write',
							filesystemScope,
							networkAccess: 'denied'
						}
					});
				}
			}
		);
	} finally {
		await fixture?.cleanup();
	}
}

describe.skipIf(process.env.BYOS_DOCKER_TESTS !== '1')(
	'Docker SDK integration (pnpm test:provider requires a local daemon and the pinned image)',
	() => {
		it('satisfies the intermediate filesystem request with Docker workspace isolation', async () => {
			await withDockerSession(
				async ({ sandbox, fixture }) => {
					const result = await sandbox.exec({
						kind: 'argv',
						executable: '/bin/sh',
						args: [
							'-c',
							'test ! -e "$1" && test ! -e /source',
							'fixture',
							fixture.outside
						]
					});

					expect({
						policy: sandbox.policy,
						result: { ...result, durationMs: 0 }
					}).toStrictEqual({
						policy: {
							workspaceAccess: 'read-write',
							filesystemScope: 'workspace-only',
							networkAccess: 'denied'
						},
						result: {
							exit: { kind: 'code', code: 0 },
							stdout: new Uint8Array(),
							stderr: new Uint8Array(),
							omittedBytes: { stdout: 0, stderr: 0 },
							durationMs: 0
						}
					});
				},
				[],
				'system-read-only'
			);
		}, 30_000);

		it('routes an approved model Bash call through the isolated Docker target', async () => {
			const model = new ScriptedModel([
				{
					type: 'toolCall',
					id: 'docker-bash',
					name: 'bash',
					arguments: {
						command:
							'[[ -n "$BASH_VERSION" ]] && printf "target bash\\n" && id -u && test ! -e /source'
					}
				}
			]);
			let approvals = 0;

			await withDockerSession(
				async ({ runtime }) => {
					runtime.session.setActiveToolsByName(['bash']);

					const selected = runtime.session.modelRuntime.getModel(
						'scripted',
						'scripted'
					);

					if (selected === undefined) {
						throw new Error('The scripted model was not registered.');
					}

					await runtime.session.setModel(selected);
					await runtime.session.prompt('Run the approved Bash tool.');

					const results = model.requests
						.at(1)
						?.messages.filter((message) => message.role === 'toolResult')
						.map(({ content, isError }) => ({ content, isError }));

					expect({ approvals, results }).toStrictEqual({
						approvals: 1,
						results: [
							{
								content: [{ type: 'text', text: 'target bash\n65534\n' }],
								isError: false
							}
						]
					});
				},
				[
					{ name: 'sandbox-tools', factory: sandboxTools },
					model.extension,
					{
						name: 'fake-approver',
						factory(pi) {
							pi.on('tool_call', () => {
								approvals++;
							});
						}
					}
				]
			);
		}, 30_000);

		it('runs the shared consumer example through the selected Docker provider', async () => {
			await withDockerSession(async ({ pi, context, fixture }) => {
				const result = await inspectWorkspace(
					sandboxClient,
					pi,
					context,
					new AbortController().signal
				);
				const duration: unknown = expect.any(Number);

				expect({ result, allocations: fixture.allocations.size }).toStrictEqual(
					{
						result: {
							exit: { kind: 'code', code: 0 },
							stdout: new TextEncoder().encode('/workspace\n'),
							stderr: new Uint8Array(),
							omittedBytes: { stdout: 0, stderr: 0 },
							durationMs: duration
						},
						allocations: 1
					}
				);
			});
		}, 30_000);

		it('preserves target signals and distinguishes a missing executable from exit 127', async () => {
			await withDockerSession(async ({ sandbox }) => {
				const signal = await sandbox.exec({
					kind: 'argv',
					executable: '/bin/sh',
					args: ['-c', 'kill -USR1 "$$"']
				});

				await expect(
					sandbox.exec({
						kind: 'argv',
						executable: '/byos-missing-command',
						args: []
					})
				).rejects.toMatchObject({ name: 'SandboxPathNotFoundError' });
				await expect(
					sandbox.exec({
						kind: 'argv',
						executable: '/workspace/source.txt',
						args: []
					})
				).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });

				const nonZero = await sandbox.exec({
					kind: 'argv',
					executable: '/bin/sh',
					args: ['-c', 'exit 127']
				});

				expect({ signal: signal.exit, nonZero: nonZero.exit }).toStrictEqual({
					signal: { kind: 'signal', signal: 'SIGUSR1', signalNumber: 10 },
					nonZero: { kind: 'code', code: 127 }
				});
			});
		}, 30_000);

		it('keeps child output and environment separate from the privileged launcher', async () => {
			await withDockerSession(async ({ sandbox }) => {
				const forged = JSON.stringify({
					kind: 'exited',
					exit: { kind: 'code', code: 99 }
				});
				const result = await sandbox.exec({
					kind: 'argv',
					executable: '/bin/sh',
					args: [
						'-c',
						'printf "%s\\n" "$1"; id -u; id -G; test ! -w /proc/1/fd/1',
						'fixture',
						forged
					],
					env: { NODE_OPTIONS: '--require=/byos-missing-module' }
				});

				expect({
					exit: result.exit,
					stdout: new TextDecoder().decode(result.stdout),
					stderr: result.stderr
				}).toStrictEqual({
					exit: { kind: 'code', code: 0 },
					stdout: `${forged}\n65534\n65534\n`,
					stderr: new Uint8Array()
				});
			});
		}, 30_000);

		it('persists target changes between jobs, keeps host files unchanged and excludes host environment', async () => {
			vi.stubEnv('BYOS_DOCKER_SENTINEL', 'synthetic-host-secret');
			await withDockerSession(async ({ sandbox, fixture }) => {
				await expect(
					sandbox.files.readFile('source.txt')
				).rejects.toMatchObject({ name: 'UnsupportedSandboxCapabilityError' });

				const removed: unknown = JSON.parse('null');
				const environment = await sandbox.exec(
					snapshotProcessRequest({
						kind: 'argv',
						executable: '/usr/bin/env',
						args: [],
						env: { HOME: removed, PATH: removed }
					})
				);
				const entries = new TextDecoder()
					.decode(environment.stdout)
					.split('\n');
				const keys = new Set(entries.map((entry) => entry.split('=', 1)[0]));
				const result = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command: 'printf target > source.txt'
				});
				const read = await sandbox.exec({
					kind: 'argv',
					executable: '/bin/cat',
					args: ['source.txt']
				});

				expect({
					environmentExit: environment.exit,
					hasHostSentinel: keys.has('BYOS_DOCKER_SENTINEL'),
					hasHome: keys.has('HOME'),
					hasPath: keys.has('PATH'),
					exit: result.exit,
					target: new TextDecoder().decode(read.stdout),
					host: await readFile(
						path.join(fixture.workspace, 'source.txt'),
						'utf8'
					)
				}).toStrictEqual({
					environmentExit: { kind: 'code', code: 0 },
					hasHostSentinel: false,
					hasHome: false,
					hasPath: false,
					exit: { kind: 'code', code: 0 },
					target: 'target',
					host: 'original'
				});
			});
		}, 30_000);

		it.each(['caller', 'deadline', 'output'] as const)(
			'confirms %s cancellation across child sessions and keeps the shared backend usable',
			async (reason) => {
				await withDockerSession(async ({ sandbox, fixture }) => {
					const controller = new AbortController();
					let hasStarted = false;
					const running = sandbox.exec(cancellationRequest, {
						signal: controller.signal,
						timeoutMs: reason === 'deadline' ? 3000 : 15_000,
						onOutput() {
							hasStarted = true;

							if (reason === 'output') {
								throw new Error('The consumer rejected output.');
							}

							if (reason === 'caller') {
								controller.abort();
							}
						}
					});

					await expect(running).rejects.toMatchObject({
						name:
							reason === 'deadline'
								? 'SandboxTimeoutError'
								: reason === 'output'
									? 'SandboxOutputCallbackError'
									: 'SandboxCancelledError',
						completion: 'confirmed'
					});
					await fixture.noJobContainers();

					const next = await sandbox.exec({
						kind: 'argv',
						executable: '/bin/pwd',
						args: []
					});

					expect({
						hasStarted,
						exit: next.exit,
						cwd: new TextDecoder().decode(next.stdout)
					}).toStrictEqual({
						hasStarted: true,
						exit: { kind: 'code', code: 0 },
						cwd: '/workspace\n'
					});
				});
			},
			30_000
		);

		it('bounds captured target output while draining the complete stream', async () => {
			await withDockerSession(async ({ sandbox }) => {
				let delivered = 0;
				const result = await sandbox.exec(
					{
						kind: 'argv',
						executable: '/bin/sh',
						args: ['-c', 'head -c 131072 /dev/zero']
					},
					{
						maxCaptureBytes: 16,
						onOutput(output) {
							delivered += output.data.byteLength;
						}
					}
				);
				const duration: unknown = expect.any(Number);

				expect({ result, delivered }).toStrictEqual({
					result: {
						exit: { kind: 'code', code: 0 },
						stdout: new Uint8Array(16),
						stderr: new Uint8Array(),
						omittedBytes: { stdout: 131_056, stderr: 0 },
						durationMs: duration
					},
					delivered: 131_072
				});
			});
		}, 30_000);

		it('isolates two sessions with the same empty host workspace', async () => {
			const fixture = await DockerFixture.create();
			const backends: SandboxBackend[] = [];

			try {
				for (const name of ['source.txt', 'nested', 'escape']) {
					await rm(path.join(fixture.workspace, name), {
						recursive: true,
						force: true
					});
				}

				const provider = createDockerProvider(() => fixture.providerClient());

				for (let index = 0; index < 2; index++) {
					backends.push(
						await provider.open(
							{
								generationId: randomUUID(),
								sessionId: randomUUID(),
								hostWorkspace: fixture.workspace,
								configuration: fixture.config,
								policy: {
									workspaceAccess: 'read-write',
									filesystemScope: 'workspace-only',
									networkAccess: 'denied'
								}
							},
							{
								...operationContext(),
								confirmCleanup() {
									return;
								},
								reportRecovery: (recovery) => {
									expect(recovery.kind).toBe('allocation');
								}
							}
						)
					);
				}

				const [left, right] = backends;

				if (left === undefined || right === undefined) {
					throw new Error('Both Docker allocations must open.');
				}

				const written = await left.exec(
					{
						kind: 'shell',
						dialect: 'sh',
						command: 'printf first > only-first'
					},
					{
						...operationContext(),
						onOutput: () => {
							return;
						}
					}
				);
				const absent = await right.exec(
					{ kind: 'shell', dialect: 'sh', command: 'test ! -e only-first' },
					{
						...operationContext(),
						onOutput: () => {
							return;
						}
					}
				);

				expect({
					isSameAllocation: left.id === right.id,
					written,
					absent
				}).toStrictEqual({
					isSameAllocation: false,
					written: { kind: 'exited', exit: { kind: 'code', code: 0 } },
					absent: { kind: 'exited', exit: { kind: 'code', code: 0 } }
				});
			} finally {
				try {
					await Promise.all(
						backends.map((backend) => backend.dispose(operationContext()))
					);
					await fixture.verifyDisposed();
				} finally {
					await fixture.cleanup();
				}
			}
		}, 30_000);
	}
);
