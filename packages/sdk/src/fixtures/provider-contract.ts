import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'vitest';

import type { SandboxBackend, SandboxProvider } from '../contracts.js';
import { SandboxCancelledError } from '../errors.js';
import { unrestrictedPolicy } from '../policy-model.js';
import type { SandboxProviderTestOptions } from '../provider-test-contracts.js';

import { MemoryBackend } from './memory-backend.js';
import { fixtureProfiles } from './profile-fixture.js';
import { visibilityFixture } from './visibility-fixture.js';

const encode = (text: string) => new TextEncoder().encode(text);

export function contractScenario(): SandboxProviderTestOptions<undefined> {
	let memory: MemoryBackend | undefined;
	let isDisposed = false;
	let isRunning = false;
	const visibility = visibilityFixture(
		'seed',
		() => memory?.bytes('seed') ?? new Uint8Array(),
		(bytes) => memory?.seed('seed', bytes)
	);
	const provider: SandboxProvider<undefined> = {
		id: 'fixture.memory',
		label: 'Contract test double without OS isolation',
		profiles: fixtureProfiles(
			{
				processKinds: ['argv', 'shell'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec', 'files.read', 'files.write', 'files.list'],
				shells: ['sh']
			},
			{
				hostWorkspaceWrites: [true],
				hostUserData: ['read-write'],
				hostSystemFiles: ['read-write'],
				network: [true]
			}
		),

		validateConfig: () => {
			return;
		},
		async open(request, context) {
			context.reportRecovery({ kind: 'none' });
			memory = new MemoryBackend();
			memory.seed('seed', new Uint8Array([0, 255, 10]));
			isDisposed = false;

			const grantedPaths = [];
			const readGrants = request.paths?.read ?? [];

			for (const hostPath of readGrants) {
				const targetPath = path.posix.join(
					memory.workspace.root,
					path.basename(hostPath)
				);
				const bytes = await readFile(hostPath);

				memory.seed(targetPath, bytes);
				grantedPaths.push({ kind: 'read' as const, hostPath, targetPath });
			}

			const backend: SandboxBackend = {
				id: memory.id,
				workspace: {
					...memory.workspace,
					...(request.profile.policy.hostUserData !== 'denied' && {
						hostUserDataRoot: '/remote/host-user-data'
					})
				},

				policyDescription: memory.policyDescription,
				recovery: memory.recovery,
				...(grantedPaths.length > 0 && { grantedPaths }),
				...(memory.files !== undefined && { files: memory.files }),
				profile: request.profile,
				exec: async (request, execution) => {
					const command =
						request.kind === 'argv' ? request.executable : request.command;

					if (
						await visibility.execute(
							command,
							(data) => {
								execution.onOutput({ stream: 'stdout', data });
							},
							execution.signal
						)
					) {
						return { kind: 'exited', exit: { kind: 'code', code: 0 } };
					}

					const target = request;

					if (target.kind === 'argv' && target.executable === 'pwd') {
						expect(target).toStrictEqual({
							kind: 'argv',
							executable: 'pwd',
							args: []
						});
						execution.onOutput({
							stream: 'stdout',
							data: encode('/remote/project\n')
						});

						return { kind: 'exited', exit: { kind: 'code', code: 0 } };
					}

					if (target.kind === 'argv' && target.executable === 'wait') {
						isRunning = true;
						await new Promise<undefined>((resolve) => {
							execution.signal.addEventListener(
								'abort',
								() => {
									resolve(undefined);
								},
								{ once: true }
							);
							execution.onOutput({ stream: 'stdout', data: encode('ready') });
						});
						isRunning = false;

						throw new SandboxCancelledError({
							operation: 'exec',
							reason: 'caller',
							completion: 'confirmed'
						});
					}

					expect(target).toStrictEqual(
						target.kind === 'argv'
							? {
									kind: 'argv',
									executable: 'probe',
									args: ['$HOME', '; exit 99']
								}
							: { kind: 'shell', dialect: 'sh', command: 'probe' }
					);
					execution.onOutput({
						stream: 'stdout',
						data: new Uint8Array([0, 255])
					});
					execution.onOutput({ stream: 'stderr', data: encode('error') });
					execution.onOutput({ stream: 'stdout', data: new Uint8Array([10]) });

					return { kind: 'exited', exit: { kind: 'code', code: 7 } };
				},
				dispose: () => {
					isDisposed = true;

					return Promise.resolve();
				}
			};

			return backend;
		}
	};
	const probe = {
		exit: { kind: 'code', code: 7 },
		stdout: new Uint8Array([0, 255, 10]),
		stderr: encode('error')
	} as const;

	return {
		label: provider.id,
		provider,
		async createFixture(selection) {
			const directory =
				selection === undefined
					? undefined
					: await mkdtemp(path.join(tmpdir(), 'byos-memory-contract-'));
			const workspace =
				directory === undefined ? undefined : await realpath(directory);

			return {
				configuration: undefined,
				hostWorkspace: workspace ?? tmpdir(),
				policy: unrestrictedPolicy,
				visibility: visibility.probe(selection?.profile.processKinds[0]),
				processes: [
					{
						...probe,
						request: {
							kind: 'argv',
							executable: 'probe',
							args: ['$HOME', '; exit 99']
						}
					}
				],
				shells: {
					sh: {
						...probe,
						request: { kind: 'shell', dialect: 'sh', command: 'probe' }
					}
				},
				read: {
					path: 'seed',
					bytes: new Uint8Array([0, 255, 10]),
					missingPath: 'absent'
				},
				write: {
					directory: 'nested',
					path: 'nested/file',
					read: () =>
						Promise.resolve(memory?.bytes('nested/file') ?? new Uint8Array())
				},
				list: {
					path: '.',
					stat: { kind: 'directory', size: 0 },
					entries: [{ name: 'seed', kind: 'file' }]
				},
				cancellation: {
					request: { kind: 'argv', executable: 'wait', args: [] },
					ready: encode('ready'),
					verifyStopped: () => {
						expect(isRunning).toBe(false);

						return Promise.resolve();
					}
				},
				verifyDisposed: () => {
					expect(isDisposed).toBe(true);

					return Promise.resolve();
				},
				cleanup: () =>
					workspace === undefined
						? Promise.resolve()
						: rm(workspace, { recursive: true, force: true })
			};
		}
	};
}
