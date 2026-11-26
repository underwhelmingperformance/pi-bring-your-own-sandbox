import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
	link,
	mkdir,
	open,
	readFile,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { connect, createServer } from 'node:net';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
	AgentSessionRuntime,
	ExtensionContext,
	InlineExtension
} from '@earendil-works/pi-coding-agent';
import type {
	Sandbox,
	SandboxClient,
	SandboxCopy
} from 'pi-bring-your-own-sandbox/consumer';
import {
	createSandboxClient,
	GrepOutput
} from 'pi-bring-your-own-sandbox/consumer';
import { closeSandboxSession } from 'pi-bring-your-own-sandbox/host';
import sandboxTools from 'pi-bring-your-own-sandbox/pi-tools';
import type {
	SandboxBackend,
	SandboxHost,
	SandboxPolicy,
	SandboxSharedSettings
} from 'pi-bring-your-own-sandbox/provider';
import {
	registerSandboxProvider,
	StaleSandboxHandleError
} from 'pi-bring-your-own-sandbox/provider';
import { Type } from 'typebox';
import { Parse } from 'typebox/value';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { withPiRuntime } from '../../../test-support/pi-runtime.js';
import { firstCopyProfile } from '../../../test-support/provider-profiles.js';
import { ScriptedModel } from '../../../test-support/scripted-model.js';
import { findHostExecutable } from '../src/host-executable.js';
import { createDockerProvider } from '../src/provider.js';

import { expectVisibleReplacement } from './checkout-visibility.js';
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
	readonly client: SandboxClient;
	readonly pi: SandboxHost;
	readonly context: ExtensionContext;
	readonly fixture: DockerFixture;
}

const readCopy = async (copy: SandboxCopy) =>
	new TextDecoder().decode(await copy.sandbox.files.readFile('source.txt'));

async function withDockerSession(
	run: (session: DockerSession) => Promise<void>,
	extensions: readonly InlineExtension[] = [],
	options: {
		readonly hostWorkspaceWrites?: boolean;
		readonly hostSystemFiles?: SandboxPolicy['hostSystemFiles'];
		readonly hasGitMetadata?: boolean;
		readonly prepareWorkspace?: (fixture: DockerFixture) => Promise<void>;
	} = {}
): Promise<void> {
	const {
		hostWorkspaceWrites = true,
		hostSystemFiles = 'denied',
		hasGitMetadata,
		prepareWorkspace
	} = options;
	let fixture: DockerFixture | undefined;
	const current: {
		pi?: SandboxHost;
		context?: ExtensionContext;
		client?: SandboxClient;
	} = {};

	try {
		let settings: SandboxSharedSettings = {};

		await withPiRuntime(
			[
				{
					name: 'docker-sdk-fixture',
					factory(pi) {
						if (fixture === undefined) {
							throw new Error('The Docker workspace was not prepared.');
						}

						const prepared = fixture;

						registerSandboxProvider(
							pi,
							import.meta.filename,
							createDockerProvider(() => prepared.providerClient()),
							{
								configure: () => ({ configuration: prepared.config, settings })
							}
						);
						current.pi = pi;
						current.client = createSandboxClient(pi, import.meta.filename);
						pi.on('session_start', (_event, context) => {
							current.context = context;
						});
					}
				},
				...extensions
			],
			async (runtime, errors) => {
				const { pi, context, client } = current;

				if (
					pi === undefined ||
					client === undefined ||
					context === undefined ||
					fixture === undefined
				) {
					throw new Error('Pi did not initialise the Docker fixture.');
				}

				const sandbox = await client.get(context);

				try {
					await run({ sandbox, fixture, pi, context, runtime, client });
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
				...(process.platform === 'darwin' && { temporaryDirectory: homedir() }),
				prepare: async (directory, agentDirectory) => {
					fixture = await DockerFixture.create(directory);

					await mkdir(path.join(directory, '.pi'), { recursive: true });

					if (hasGitMetadata) {
						await promisify(execFile)('git', ['init', '--quiet', directory]);
						await writeFile(path.join(directory, '.pi', 'settings.json'), '{}');
						await writeFile(path.join(directory, '.envrc'), 'initial');
					}

					await prepareWorkspace?.(fixture);
					vi.stubEnv('PI_CODING_AGENT_DIR', agentDirectory);
					settings = {
						policy: {
							hostWorkspaceWrites,
							hostUserData: 'denied',
							hostSystemFiles,
							network: false
						}
					};
				}
			}
		);
	} finally {
		await fixture?.cleanup();
	}
}

async function copyHostCheckout(fixture: DockerFixture) {
	const provider = createDockerProvider(() => fixture.providerClient());
	const backend = await provider.copy(
		{
			generationId: randomUUID(),
			sessionId: randomUUID(),
			hostWorkspace: fixture.workspace,
			configuration: fixture.config,
			profile: firstCopyProfile(provider),
			source: { kind: 'host' }
		},
		{
			...operationContext(),
			confirmCleanup() {
				return;
			},
			reportRecovery(recovery) {
				expect(recovery.kind).toBe('allocation');
			}
		}
	);
	const { read, write } = backend.files ?? {};

	if (read === undefined || write === undefined) {
		await backend.dispose(operationContext());

		throw new Error('Docker host copies must expose file reads and writes.');
	}

	return { backend, read, write };
}

function withDockerCopy(
	run: (session: DockerSession) => Promise<void>
): Promise<void> {
	return withDockerSession(async (session) => {
		const copy = await session.sandbox.copy();

		try {
			await run({ ...session, sandbox: copy.sandbox });
		} finally {
			await copy.close();
		}
	});
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
							hostWorkspaceWrites: true,
							hostUserData: 'denied',
							hostSystemFiles: 'denied',
							network: false
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
				{ hostSystemFiles: 'read-only' }
			);
		}, 30_000);

		it('shares editor saves across shell and SDK requests while each review retains its inputs', async () => {
			await withDockerSession(
				async ({ sandbox, fixture, pi, context }) => {
					expect(sandbox.workspace.relationship).toBe('shared');

					for (const [file, contents] of [
						['.envrc', 'initial'],
						['.pi/settings.json', '{}']
					] as const) {
						await expect(
							sandbox.files.writeFile(file, Buffer.from('change'))
						).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });

						const denied = await sandbox.exec({
							kind: 'shell',
							dialect: 'sh',
							command: 'echo change > ' + file
						});

						expect(denied.exit).not.toStrictEqual({ kind: 'code', code: 0 });
						expect(
							await readFile(path.join(fixture.workspace, file), 'utf8')
						).toBe(contents);
					}

					await sandbox.files.writeFile('created.txt', Buffer.from('agent'));

					const filename = path.join(fixture.workspace, 'created.txt');

					expect(await readFile(filename, 'utf8')).toBe('agent');

					const metadata = await stat(filename);

					expect(metadata.uid).toBe(process.getuid?.());

					const review = await sandbox.copy();

					try {
						const replacement = path.join(fixture.workspace, 'editor.tmp');

						await writeFile(replacement, 'editor');
						await rename(replacement, filename);

						const shell = await sandbox.exec({
							kind: 'shell',
							dialect: 'sh',
							command: `
while contents=$(cat created.txt); do
  if [ "$contents" = editor ]; then
    printf '%s' "$contents"
    exit 0
  fi
  sleep 0.01
done
exit 1`
						});

						expect({
							exit: shell.exit,
							shell: new TextDecoder().decode(shell.stdout),
							worker: new TextDecoder().decode(
								await sandbox.files.readFile('created.txt')
							)
						}).toStrictEqual({
							exit: { kind: 'code', code: 0 },
							shell: 'editor',
							worker: 'editor'
						});

						await writeFile(replacement, 'replacement');
						await rename(replacement, path.join(fixture.workspace, '.envrc'));

						const replacedAt = performance.now();

						await expectVisibleReplacement(
							() => sandbox.files.readFile('.envrc'),
							new TextEncoder().encode('replacement'),
							replacedAt
						);
						expect(
							await review.sandbox.files.readFile('created.txt')
						).toStrictEqual(new TextEncoder().encode('agent'));
					} finally {
						await review.close();
					}

					const xdg = path.join(fixture.workspace, 'xdg');

					await mkdir(path.join(xdg, 'git'), { recursive: true });
					await mkdir(path.join(fixture.workspace, 'hooks'));

					const config = path.join(xdg, 'git', 'config');

					await writeFile(config, '[core]\n\thooksPath = hooks\n');
					vi.stubEnv('XDG_CONFIG_HOME', xdg);
					await expect(
						sandbox.files.writeFile('hooks/config-test', Buffer.from('example'))
					).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });
					await mkdir(path.join(fixture.workspace, 'hooks '));
					await writeFile(config, '[core]\n\thooksPath = "hooks "\n');
					await expect(sandbox.files.stat('created.txt')).rejects.toMatchObject(
						{ name: 'UnsupportedSandboxPolicyError', operation: 'stat' }
					);
					await closeSandboxSession(pi, context);
					expect(await readFile(filename, 'utf8')).toBe('editor');
				},
				[],
				{ hasGitMetadata: true }
			);
		});

		it.each([true, false])(
			'pins nested protected paths with workspace writes set to %s',
			async (hostWorkspaceWrites) => {
				await withDockerSession(
					async ({ sandbox, fixture }) => {
						const result = await sandbox.exec({
							kind: 'argv',
							executable: '/usr/local/bin/node',
							args: [
								'-e',
								`
const { renameSync, writeFileSync, unlinkSync } = require('node:fs');
function check(action) {
	try { action(); return 'ok'; } catch (error) { return error.code; }
}
process.stdout.write(JSON.stringify([
	check(() => writeFileSync('tools/hooks/sibling.txt', 'edited')),
	check(() => writeFileSync('tools/hooks/created.txt', 'created')),
	check(() => unlinkSync('tools/hooks/delete.txt')),
	check(() => writeFileSync('tools/hooks/nested/pre-commit', 'changed')),
	check(() => renameSync('tools/hooks/nested', 'tools/hooks/moved')),
	check(() => renameSync('tools/hooks', 'tools/moved')),
	check(() => renameSync('tools', 'moved'))
]));
`
							]
						});
						const siblingResult = hostWorkspaceWrites ? 'ok' : 'EROFS';
						const renameResult = hostWorkspaceWrites ? 'EBUSY' : 'EROFS';

						expect({
							exit: result.exit,
							stdout: new TextDecoder().decode(result.stdout),
							stderr: new TextDecoder().decode(result.stderr)
						}).toStrictEqual({
							exit: { kind: 'code', code: 0 },
							stdout: JSON.stringify([
								siblingResult,
								siblingResult,
								siblingResult,
								'EROFS',
								renameResult,
								renameResult,
								renameResult
							]),
							stderr: ''
						});

						expect(
							await readFile(
								path.join(fixture.workspace, 'tools/hooks/nested/pre-commit'),
								'utf8'
							)
						).toBe('fixture');
						await expect(
							sandbox.files.writeFile(
								'tools/hooks/nested/pre-commit',
								Buffer.from('worker')
							)
						).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });

						const workerWrite = sandbox.files.writeFile(
							'tools/worker.txt',
							Buffer.from('worker')
						);

						if (!hostWorkspaceWrites) {
							await expect(workerWrite).rejects.toMatchObject({
								name: 'SandboxPermissionDeniedError'
							});

							return;
						}

						await workerWrite;
						expect(
							await readFile(
								path.join(fixture.workspace, 'tools/worker.txt'),
								'utf8'
							)
						).toBe('worker');
					},
					[],
					{
						hostWorkspaceWrites,
						hasGitMetadata: true,
						async prepareWorkspace({ workspace }) {
							await mkdir(path.join(workspace, 'tools/hooks/nested'), {
								recursive: true
							});
							await writeFile(
								path.join(workspace, 'tools/hooks/nested/pre-commit'),
								'fixture'
							);
							await writeFile(
								path.join(workspace, 'tools/hooks/sibling.txt'),
								'initial'
							);
							await writeFile(
								path.join(workspace, 'tools/hooks/delete.txt'),
								'initial'
							);
							await promisify(execFile)('git', [
								'-C',
								workspace,
								'config',
								'core.hooksPath',
								'tools/hooks/nested'
							]);
						}
					}
				);
			},
			30_000
		);

		it('takes fresh independent copies of a sandbox and the host checkout', async () => {
			await withDockerSession(async ({ fixture, sandbox }) => {
				await sandbox.files.writeFile('source.txt', Buffer.from('first'));

				const first = await sandbox.copy();

				await sandbox.files.writeFile('source.txt', Buffer.from('second'));

				const second = await sandbox.copy();
				const { backend: host, read, write } = await copyHostCheckout(fixture);
				const readHost = async () =>
					new TextDecoder().decode(
						await read.readFile('source.txt', operationContext())
					);

				try {
					expect(
						await Promise.all([readCopy(first), readCopy(second), readHost()])
					).toStrictEqual(['first', 'second', 'second']);
					expect(host.profile.policy).toStrictEqual({
						hostWorkspaceWrites: false,
						hostUserData: 'denied',
						hostSystemFiles: 'denied',
						network: false
					});
					await first.close();

					const shell = await second.sandbox.exec({
						kind: 'shell',
						dialect: 'sh',
						command: 'cat source.txt'
					});

					expect(new TextDecoder().decode(shell.stdout)).toBe('second');
					await write.writeFile(
						'source.txt',
						Buffer.from('private'),
						operationContext()
					);
					expect(
						await Promise.all([readHost(), readCopy(second)])
					).toStrictEqual(['private', 'second']);
				} finally {
					await Promise.all([
						first.close(),
						second.close(),
						host.dispose(operationContext())
					]);
				}
			});
		}, 30_000);

		it('rejects a copy requirement to write the live checkout and grants writes inside the copy', async () => {
			await withDockerSession(async ({ sandbox, fixture }) => {
				const allocations = fixture.allocations.size;

				await expect(
					sandbox.copy({ access: { hostWorkspaceWrites: 'needed' } })
				).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError',
					detail: {
						kind: 'access',
						property: 'hostWorkspaceWrites',
						value: 'needed',
						reason: 'profile'
					}
				});
				expect(fixture.allocations.size).toBe(allocations);

				const copy = await sandbox.copy({
					access: { paths: { write: ['source.txt'] } }
				});

				try {
					await copy.sandbox.files.writeFile('source.txt', Buffer.from('copy'));
					expect({
						policy: copy.sandbox.policy,
						copy: await readCopy(copy),
						source: await readFile(
							path.join(fixture.workspace, 'source.txt'),
							'utf8'
						)
					}).toStrictEqual({
						policy: {
							hostWorkspaceWrites: false,
							hostUserData: 'denied',
							hostSystemFiles: 'denied',
							network: false
						},
						copy: 'copy',
						source: 'original'
					});
				} finally {
					await copy.close();
				}
			});
		}, 30_000);

		it('counts each inode once when importing hard-linked files', async () => {
			await withDockerSession(async ({ sandbox }) => {
				const prepared = await sandbox.exec({
					kind: 'shell',
					dialect: 'sh',
					command:
						'set -e; truncate -s 9M data; for i in $(seq 1 57); do ln data "alias$i"; done'
				});

				expect(prepared.exit).toStrictEqual({ kind: 'code', code: 0 });

				const review = await sandbox.copy();

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

		it('copies an entry with a link outside the checkout as workspace content', async () => {
			await withDockerSession(
				async ({ fixture }) => {
					const {
						backend: copy,
						read,
						write
					} = await copyHostCheckout(fixture);

					try {
						const contents = new TextDecoder().decode(
							await read.readFile('added', operationContext())
						);

						await write.writeFile(
							'added',
							Buffer.from('private'),
							operationContext()
						);
						expect({
							contents,
							outside: await readFile(fixture.outside, 'utf8')
						}).toStrictEqual({
							contents: 'host-only',
							outside: 'host-only'
						});
					} finally {
						await copy.dispose(operationContext());
					}
				},
				[],
				{
					prepareWorkspace: (fixture) =>
						link(fixture.outside, path.join(fixture.workspace, 'added'))
				}
			);
		}, 30_000);

		it('rejects a host copy with an oversized file and preserves the active backend', async () => {
			await withDockerSession(async ({ fixture, sandbox }) => {
				await using file = await open(
					path.join(fixture.workspace, 'added'),
					'wx'
				);

				await file.truncate(512 * 1024 * 1024 + 1);

				await expect(copyHostCheckout(fixture)).rejects.toMatchObject({
					name: 'SandboxOperationError',
					operation: 'open',
					cause: {
						message: 'The Docker workspace exceeds the snapshot import limits.'
					}
				});
				await expect(
					sandbox.files.readFile('source.txt')
				).resolves.toStrictEqual(new TextEncoder().encode('original'));
			});
		}, 30_000);

		it('keeps a host file unchanged when a hard link appears after copying', async () => {
			await withDockerCopy(async ({ sandbox, fixture }) => {
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

		it('excludes a FIFO added to the host checkout after copying', async () => {
			await withDockerCopy(async ({ sandbox, fixture }) => {
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

		it('excludes a socket added to the host checkout after copying', async () => {
			await withDockerCopy(async ({ sandbox, fixture }) => {
				const socketPath = await fixture.socketEndpoint();
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
				isEscalated: false,
				prefixChanged: false,
				contents: 'checkout edit',
				text: `target bash\n${String(process.getuid?.())}\n`,
				blocked: false
			},
			{
				isEscalated: false,
				contents: 'checkout edit',
				prefixChanged: true,
				text: new StaleSandboxHandleError({ operation: 'exec' }).message,
				blocked: false
			},
			{
				isEscalated: true,
				prefixChanged: false,
				contents: 'checkout edit',
				text: 'Host command reviewed.',
				blocked: true
			}
		])(
			'reviews the destination of a model Bash call with escalation $isEscalated and prefix change $prefixChanged',
			async ({ isEscalated, contents, text, blocked, prefixChanged }) => {
				let changePrefix: (() => void) | undefined;
				const model = new ScriptedModel([
					{
						type: 'toolCall',
						id: 'docker-bash',
						name: 'bash',
						arguments: {
							...(isEscalated && {
								escalate: ['network'],
								justification: 'Review the host checkout.'
							}),
							command:
								'[[ -n "$BASH_VERSION" ]] && printf "target bash\\n" && id -u && test ! -e /source'
						}
					}
				]);
				const reviewed: string[] = [];

				await withDockerSession(
					async ({ runtime, sandbox }) => {
						changePrefix = () => {
							runtime.services.settingsManager.setShellCommandPrefix(
								'export LC_ALL=C'
							);
						};

						await sandbox.files.writeFile(
							'source.txt',
							Buffer.from('checkout edit')
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
									content: [
										{ type: 'text', text },
										...(blocked || prefixChanged
											? []
											: [
													{
														type: 'text',
														text: 'Effective restrictions: Host workspace writes allowed, network denied, host user data denied, host system files denied'
													}
												])
									],
									isError: blocked || prefixChanged
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
								const client = createSandboxClient(pi, import.meta.filename);

								pi.on('tool_call', async (event, context) => {
									const result = client.findShellReviewSource(context, event);

									if (!result.ok) {
										return {
											block: true,
											reason: 'The proposed tool has no review destination.'
										};
									}

									const { source } = result;
									const review = await source.copy();

									try {
										reviewed.push(await readCopy(review));
									} finally {
										await review.close();
									}

									if (prefixChanged) {
										changePrefix?.();
									}

									if (blocked && source.escalation !== undefined) {
										client.recordEscalationDecision(
											context,
											source.escalation,
											'deny'
										);
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

		it('runs a consumer through the selected Docker provider', async () => {
			await withDockerSession(async ({ client, context, fixture }) => {
				const consumer = await client.get(context);
				const result = await consumer.exec({
					kind: 'argv',
					executable: 'pwd',
					args: []
				});
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
					stdout: `${forged}\n${String(process.getuid?.())}\n${String(process.getgid?.())}\n`,
					stderr: new Uint8Array()
				});
			});
		}, 30_000);

		it('persists target changes in the checkout between jobs and excludes host environment', async () => {
			vi.stubEnv('BYOS_DOCKER_SENTINEL', 'synthetic-host-secret');
			await withDockerSession(async ({ sandbox, fixture }) => {
				expect(await sandbox.files.readFile('source.txt')).toStrictEqual(
					new TextEncoder().encode('original')
				);

				const overrides = Parse(
					Type.Record(Type.String(), Type.Null()),
					JSON.parse('{"HOME":null,"PATH":null}')
				);
				const environment = await sandbox.exec({
					kind: 'argv',
					executable: '/usr/bin/env',
					args: [],
					env: overrides
				});
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
					host: 'target'
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

		it('rejects backreferences and keeps the grep worker usable', async () => {
			await withDockerSession(async ({ sandbox }) => {
				const path = 'source.txt';

				await expect(
					sandbox.search.grep({ path, pattern: '(a)\\1' })
				).rejects.toMatchObject({
					name: 'SandboxOperationError'
				});

				for (const asset of ['index.mjs', 'package.json']) {
					await expect(
						sandbox.files.writeFile(
							'/opt/pi-byos/node_modules/re2js/' + asset,
							Uint8Array.of(1)
						)
					).rejects.toMatchObject({ name: 'SandboxPermissionDeniedError' });
				}

				expect(
					await sandbox.search.grep({
						path,
						pattern: '^ORIG\\p{L}+$',
						ignoreCase: true
					})
				).toStrictEqual({
					matches: [{ path, line: 1, text: 'original', before: [], after: [] }],
					truncated: false
				});
			});
		});

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

		it('routes Pi file tools and Bash through the same Docker workspace', async () => {
			const calls = [
				[
					'write',
					{ path: 'tools-probe.txt', content: 'before\nalpha\nafter\n' }
				],
				[
					'edit',
					{
						path: 'tools-probe.txt',
						edits: [{ oldText: 'alpha', newText: 'needle' }]
					}
				],
				['read', { path: 'tools-probe.txt' }],
				['ls', { path: '.' }],
				['find', { pattern: 'tools-probe.txt' }],
				['grep', { pattern: 'needle', path: 'tools-probe.txt', context: 1 }],
				['bash', { command: 'cat tools-probe.txt' }],
				['write', { path: '.envrc', content: 'should not reach the host' }],
				['read', { path: 'pixel.data' }]
			] as const;
			const model = new ScriptedModel(
				calls.map(([name, arguments_], index) => ({
					type: 'toolCall',
					id: 'file-tool-' + String(index),
					name,
					arguments: arguments_
				}))
			);

			await withDockerSession(
				async ({ runtime, fixture }) => {
					await writeFile(
						path.join(fixture.workspace, 'pixel.data'),
						Buffer.from(
							'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/7/QAAAAASUVORK5CYII=',
							'base64'
						)
					);
					runtime.session.agent.toolExecution = 'sequential';
					runtime.session.setActiveToolsByName([
						'read',
						'write',
						'edit',
						'ls',
						'find',
						'grep',
						'bash'
					]);

					const selected = runtime.session.modelRuntime.getModel(
						'scripted',
						'scripted'
					);

					if (selected === undefined) {
						throw new Error('The scripted model was not registered.');
					}

					await runtime.session.setModel(selected);
					await runtime.session.prompt('Exercise the sandbox file tools.');

					const results = model.requests
						.at(1)
						?.messages.filter((message) => message.role === 'toolResult')
						.map((message) => ({
							name: message.toolName,
							isError: message.isError,
							text: message.content
								.filter((block) => block.type === 'text')
								.map((block) => block.text)
								.join('\n')
						}));
					const edited = 'before\nneedle\nafter\n';

					expect(
						results?.map(({ name, isError }) => [name, isError])
					).toStrictEqual([
						['write', false],
						['edit', false],
						['read', false],
						['ls', false],
						['find', false],
						['grep', false],
						['bash', false],
						['write', true],
						['read', false]
					]);
					expect({
						read: results?.[2]?.text,
						ls: results?.[3]?.text.includes('tools-probe.txt'),
						find: results?.[4]?.text,
						grep: results?.[5]?.text,
						bash: results?.[6]?.text.includes('before\nneedle\nafter'),
						image: results?.[8]?.text.includes('Read image file [image/png]'),
						workspace: await readFile(
							path.join(fixture.workspace, 'tools-probe.txt'),
							'utf8'
						),
						protected: await readFile(
							path.join(fixture.workspace, '.envrc'),
							'utf8'
						)
					}).toStrictEqual({
						read: edited,
						ls: true,
						find: 'tools-probe.txt',
						grep: 'tools-probe.txt-1- before\ntools-probe.txt:2: needle\ntools-probe.txt-3- after',
						bash: true,
						image: true,
						workspace: edited,
						protected: 'initial'
					});
				},
				[
					{
						name: 'sandbox-tools',
						factory(pi) {
							sandboxTools(pi, '<inline:sandbox-tools>');
						}
					},
					model.extension
				],
				{ hasGitMetadata: true }
			);
		}, 60_000);

		it('matches ripgrep ignore rules, explicit files and glob overrides', async () => {
			await withDockerSession(
				async ({ sandbox, fixture }) => {
					const corpus = {
						'.gitignore': 'omitted.txt\npruned/\n',
						'.ignore': 'ignore-wins.txt\n',
						'.rgignore': '!ignore-wins.txt\nrg-omits.txt\n',
						'.git/info/exclude': 'git-excluded.txt\n',
						'.hidden.txt': 'needle\n',
						'node_modules/pkg/index.txt': 'needle\n',
						'omitted.txt': 'needle\n',
						'pruned/deep.txt': 'needle\n',
						'git-excluded.txt': 'needle\n',
						'ignore-wins.txt': 'needle\n',
						'rg-omits.txt': 'needle\n',
						'unmatched.txt': 'different\n'
					};

					for (const [filename, content] of Object.entries(corpus)) {
						const target = path.join(fixture.workspace, filename);

						await mkdir(path.dirname(target), { recursive: true });
						await writeFile(target, content);
					}

					const reference = await findHostExecutable('rg', fixture.workspace);

					if (reference === undefined) {
						throw new Error(
							'Install ripgrep on the host to run the provider parity test.'
						);
					}

					const results = [];

					for (const [root, glob] of [
						['.', undefined],
						['.', 'omitted.txt'],
						['.', '!node_modules'],
						['omitted.txt', '*.md'],
						['pruned', undefined]
					] as const) {
						const basename = root === 'omitted.txt' ? root : '.';
						const directory = root === 'pruned' ? 'pruned' : '.';
						const arguments_ = [
							'--no-config',
							'--json',
							'--line-number',
							'--color=never',
							'--hidden',
							...(glob === undefined ? [] : ['--glob', glob]),
							'--',
							'needle',
							basename
						];
						const { stdout } = await promisify(execFile)(
							reference,
							arguments_,
							{
								cwd: path.join(fixture.workspace, directory),
								env: { HOME: fixture.workspace, GIT_CONFIG_GLOBAL: '/dev/null' }
							}
						);
						const output = new GrepOutput(0, 100);

						output.write(Buffer.from(stdout));

						const expected = output.finish();
						const actual = await sandbox.search.grep({
							pattern: 'needle',
							path: root,
							...(glob !== undefined && { glob })
						});

						results.push({ actual, expected, root, glob });
					}

					for (const { actual, expected, root, glob } of results) {
						expect(actual, JSON.stringify({ root, glob })).toStrictEqual(
							expected
						);
					}
				},
				[],
				{ hasGitMetadata: true }
			);
		}, 30_000);

		it('searches representable filenames in a copy and truncates before reading omitted context', async () => {
			await withDockerCopy(async ({ sandbox }) => {
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
						await provider.copy(
							{
								generationId: randomUUID(),
								sessionId: randomUUID(),
								hostWorkspace: fixture.workspace,
								configuration: fixture.config,
								profile: firstCopyProfile(provider),
								source: { kind: 'host' }
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
