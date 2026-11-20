import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { link, open, readFile, rm, writeFile } from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
	AgentSessionRuntime,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import type {
	ReviewSnapshot,
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

const readSnapshot = async (snapshot: ReviewSnapshot) =>
	new TextDecoder().decode(await snapshot.sandbox.files.readFile('source.txt'));

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

describe.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')(
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

		it('takes fresh independent review snapshots from the proposed command destination', async () => {
			await withDockerSession(async ({ pi, context, sandbox }) => {
				const source = {
					kind: 'sandbox' as const,
					providerId: sandbox.providerId,
					generationId: sandbox.generationId,
					backendId: sandbox.backendId
				};

				await sandbox.files.writeFile('source.txt', Buffer.from('first'));

				const first = await sandboxClient.openReviewSnapshot(
					pi,
					context,
					source
				);

				await sandbox.files.writeFile('source.txt', Buffer.from('second'));

				const second = await sandboxClient.openReviewSnapshot(
					pi,
					context,
					source
				);
				const host = await sandboxClient.openReviewSnapshot(pi, context, {
					kind: 'host'
				});

				try {
					expect(
						await Promise.all([
							readSnapshot(first),
							readSnapshot(second),
							readSnapshot(host)
						])
					).toStrictEqual(['first', 'second', 'original']);
					await first.close();

					const shell = await second.sandbox.exec({
						kind: 'shell',
						dialect: 'sh',
						command: 'cat source.txt'
					});

					expect(new TextDecoder().decode(shell.stdout)).toBe('second');
					await expect(
						host.sandbox.files.writeFile('source.txt', Uint8Array.of(9))
					).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });
				} finally {
					await Promise.all([first.close(), second.close(), host.close()]);
				}
			});
		}, 30_000);

		it('counts each inode once when importing hard-linked files', async () => {
			await withDockerSession(async ({ pi, context, sandbox }) => {
				const prepared = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command:
						'set -e; truncate -s 9M data; for i in $(seq 1 57); do ln data "alias$i"; done'
				});

				expect(prepared.exit).toStrictEqual({ kind: 'code', code: 0 });

				const review = await sandboxClient.openReviewSnapshot(pi, context, {
					kind: 'sandbox',
					providerId: sandbox.providerId,
					generationId: sandbox.generationId,
					backendId: sandbox.backendId
				});

				try {
					const result = await review.sandbox.exec({
						kind: 'shell',
						dialect: 'sh',
						command: 'test data -ef alias57 && stat -c "%h %s" alias57'
					});

					expect(new TextDecoder().decode(result.stdout)).toBe('58 9437184\n');
				} finally {
					await review.close();
				}
			});
		}, 30_000);

		it.each([
			[
				'external hard link',
				'A regular file has a hard link outside the workspace.'
			],
			[
				'oversized file',
				'The Docker workspace exceeds the snapshot import limits.'
			]
		])(
			'rejects a host snapshot with an %s and preserves the active backend',
			async (defect, message) => {
				await withDockerSession(async ({ pi, context, fixture, sandbox }) => {
					const added = path.join(fixture.workspace, 'added');

					if (defect === 'external hard link') {
						await link(fixture.outside, added);
					} else {
						await using file = await open(added, 'wx');
						await file.truncate(512 * 1024 * 1024 + 1);
					}

					await expect(
						sandboxClient.openReviewSnapshot(pi, context, { kind: 'host' })
					).rejects.toMatchObject({
						name: 'SandboxOperationError',
						operation: 'open',
						cause: { cause: { message } }
					});
					await expect(
						sandbox.files.readFile('source.txt')
					).resolves.toStrictEqual(new TextEncoder().encode('original'));
				});
			},
			30_000
		);
		it('keeps a host file unchanged when a hard link appears after opening', async () => {
			await withDockerSession(async ({ sandbox, fixture }) => {
				await link(fixture.outside, path.join(fixture.workspace, 'alias'));

				const result = await sandbox.exec({
					kind: 'argv',
					executable: '/usr/local/bin/node',
					args: [
						'-e',
						`
const fs = require('node:fs');
fs.writeFileSync('ordinary', 'edited');
try {
  fs.writeFileSync('alias', 'edited');
} catch (error) {
  if (!['EACCES', 'EPERM', 'EMLINK'].includes(error.code)) throw error;
}
`
					]
				});

				expect({
					exit: result.exit,
					outside: await readFile(fixture.outside, 'utf8')
				}).toStrictEqual({
					exit: { kind: 'code', code: 0 },
					outside: 'host-only'
				});
			});
		}, 30_000);

		it('isolates a host FIFO created in the workspace after opening', async () => {
			await withDockerSession(async ({ sandbox, fixture }) => {
				const channel = path.join(fixture.workspace, 'channel');

				await promisify(execFile)('mkfifo', [channel]);

				await using reader = await open(
					channel,
					constants.O_RDONLY | constants.O_NONBLOCK
				);

				const byte = Buffer.alloc(1);

				await writeFile(channel, 'x');

				const control = await reader.read(byte);

				expect([control.bytesRead, byte.toString()]).toStrictEqual([1, 'x']);

				const result = await sandbox.exec({
					kind: 'argv',
					executable: '/usr/local/bin/node',
					args: [
						'-e',
						`
const fs = require('node:fs');
try {
  const fd = fs.openSync('channel', fs.constants.O_WRONLY | fs.constants.O_NONBLOCK);
  fs.writeSync(fd, 'y');
  fs.closeSync(fd);
} catch (error) {
  if (!['ENOENT', 'EACCES', 'EPERM', 'ENXIO'].includes(error.code)) throw error;
}
`
					]
				});

				const { bytesRead } = await reader.read(byte);

				expect({ exit: result.exit, bytesRead }).toStrictEqual({
					exit: { kind: 'code', code: 0 },
					bytesRead: 0
				});
			});
		}, 30_000);

		it('isolates a host socket created in the workspace after opening', async () => {
			await withDockerSession(async ({ sandbox, fixture }) => {
				const socketPath = path.join(fixture.workspace, 's');
				let connections = 0;
				const listener = createServer((peer) => {
					connections++;
					peer.end();
				});

				try {
					listener.listen(socketPath);
					await once(listener, 'listening');

					const control = connect(socketPath);

					await once(control, 'close');

					const result = await sandbox.exec({
						kind: 'argv',
						executable: '/usr/local/bin/node',
						args: [
							'-e',
							`
const socket = require('node:net').connect('/workspace/s');
socket.on('connect', () => { process.exitCode = 1; });
socket.on('error', error => {
  if (!['ENOENT', 'EACCES', 'EPERM'].includes(error.code)) throw error;
});
`
						]
					});

					expect({ exit: result.exit, connections }).toStrictEqual({
						exit: { kind: 'code', code: 0 },
						connections: 1
					});
				} finally {
					await listener[Symbol.asyncDispose]();
				}
			});
		}, 30_000);

		it.each([
			{
				execution: 'sandbox',
				contents: 'target-only edit',
				text: 'target bash\n65534\n',
				blocked: false
			},
			{
				execution: 'outside-sandbox',
				contents: 'original',
				text: 'Host command reviewed.',
				blocked: true
			}
		])(
			'reviews the destination of a model Bash call with execution $execution',
			async ({ execution, contents, text, blocked }) => {
				const model = new ScriptedModel([
					{
						type: 'toolCall',
						id: 'docker-bash',
						name: 'bash',
						arguments: {
							execution,
							...(blocked && { justification: 'Review the host checkout.' }),
							command:
								'[[ -n "$BASH_VERSION" ]] && printf "target bash\\n" && id -u && test ! -e /source'
						}
					}
				]);
				const reviewed: string[] = [];

				await withDockerSession(
					async ({ runtime, sandbox }) => {
						await sandbox.files.writeFile(
							'source.txt',
							Buffer.from('target-only edit')
						);
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

						expect({ reviewed, results }).toStrictEqual({
							reviewed: [contents],
							results: [
								{
									content: [{ type: 'text', text }],
									isError: blocked
								}
							]
						});
					},
					[
						{
							name: 'sandbox-tools',
							factory: (pi) => {
								sandboxTools(pi, '<inline:sandbox-tools>');
							}
						},
						model.extension,
						{
							name: 'fake-approver',
							factory(pi) {
								pi.on('tool_call', async (event, context) => {
									const routes: ((
										signal: AbortSignal
									) => Promise<ReviewSnapshot>)[] = [];

									pi.events.emit('pi-byos:review:tool-call:v1', {
										sessionId: context.sessionManager.getSessionId(),
										toolName: event.toolName,
										toolCallId: event.toolCallId,
										reply: (
											open: (signal: AbortSignal) => Promise<ReviewSnapshot>
										) => {
											routes.push(open);
										}
									});

									const [open] = routes;

									if (!open || routes.length !== 1) {
										return {
											block: true,
											reason: 'The proposed tool has no review destination.'
										};
									}

									const review = await open(new AbortController().signal);

									try {
										reviewed.push(await readSnapshot(review));
									} finally {
										await review.close();
									}

									return blocked
										? { block: true, reason: 'Host command reviewed.' }
										: {};
								});
							}
						}
					]
				);
			},
			30_000
		);

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
				expect(await sandbox.files.readFile('source.txt')).toStrictEqual(
					new TextEncoder().encode('original')
				);

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

		it('searches dense text through a root symlink and skips oversized and binary files', async () => {
			await withDockerSession(async ({ sandbox }) => {
				const setup = await sandbox.exec({
					kind: 'argv',
					executable: '/usr/local/bin/node',
					args: [
						'-e',
						`const fs=require('node:fs');fs.mkdirSync('tree');fs.symlinkSync('tree','view');fs.writeFileSync('tree/binary',Buffer.from('needle\\0'));fs.writeFileSync('tree/large','needle');fs.truncateSync('tree/large',17*1024*1024);fs.writeFileSync('tree/dense','before\\nneedle\\nafter\\n'+'\\n'.repeat(8000000));`
					]
				});

				expect(setup.exit).toStrictEqual({ kind: 'code', code: 0 });
				expect(
					await sandbox.search.grep({
						path: 'view',
						pattern: 'needle',
						literal: true,
						context: 1,
						limit: 1
					})
				).toStrictEqual({
					matches: [
						{
							path: 'dense',
							line: 2,
							text: 'needle',
							before: ['before'],
							after: ['after']
						}
					],
					truncated: false
				});
			});
		}, 30_000);

		it('searches representable filenames and truncates before reading omitted context', async () => {
			await withDockerSession(async ({ sandbox }) => {
				const setup = await sandbox.exec({
					kind: 'argv',
					executable: '/usr/local/bin/node',
					args: [
						'-e',
						`const fs=require('node:fs');fs.mkdirSync('scope');fs.writeFileSync('scope/a','hit\\n');fs.writeFileSync('scope/b','hit\\n'+'\\n'.repeat(65537));fs.writeFileSync(Buffer.concat([Buffer.from('scope/'),Buffer.from([255])]),'hit');`
					]
				});

				expect(setup.exit).toStrictEqual({ kind: 'code', code: 0 });
				expect(
					await sandbox.search.grep({
						path: 'scope',
						pattern: 'hit',
						literal: true,
						context: 65_537,
						limit: 1
					})
				).toStrictEqual({
					matches: [{ path: 'a', line: 1, text: 'hit', before: [], after: [] }],
					truncated: true
				});
				expect(
					await sandbox.search.find({ path: 'scope', pattern: '*' })
				).toStrictEqual({ paths: ['a', 'b'], truncated: false });

				const listed = await sandbox.files.listDirectory('scope');

				expect(
					listed.toSorted((a, b) => a.name.localeCompare(b.name))
				).toStrictEqual([
					{ name: 'a', kind: 'file' },
					{ name: 'b', kind: 'file' }
				]);
			});
		}, 30_000);

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
