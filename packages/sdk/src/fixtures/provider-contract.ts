import { expect } from 'vitest';

import type { SandboxBackend, SandboxProvider } from '../contracts.js';
import { SandboxCancelledError } from '../errors.js';
import type { SandboxProviderTestOptions } from '../provider-test-contracts.js';

import { MemoryBackend } from './memory-backend.js';

const encode = (text: string) => new TextEncoder().encode(text);

export function contractScenario(): SandboxProviderTestOptions<undefined> {
	let memory: MemoryBackend | undefined;
	let isDisposed = false;
	let isRunning = false;
	const provider: SandboxProvider<undefined> = {
		id: 'fixture.memory',
		label: 'Contract test double without OS isolation',
		protocolVersion: 1,
		capabilities: {
			processKinds: ['argv', 'shell'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec', 'files.read', 'files.write', 'files.list'],
			shells: ['sh']
		},
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		validateConfig: () => {
			return;
		},
		open(_request, context) {
			context.reportRecovery({ kind: 'none' });
			memory = new MemoryBackend();
			memory.seed('seed', new Uint8Array([0, 255, 10]));
			isDisposed = false;

			const backend: SandboxBackend = {
				id: memory.id,
				workspace: memory.workspace,
				policy: memory.policy,
				policyDescription: memory.policyDescription,
				recovery: memory.recovery,
				...(memory.files !== undefined && { files: memory.files }),
				capabilities: provider.capabilities,
				exec: async (request, execution) => {
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

			return Promise.resolve(backend);
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
		createFixture: () =>
			Promise.resolve({
				configuration: undefined,
				hostWorkspace: '/host',
				policy: {
					workspaceAccess: 'read-write',
					filesystemScope: 'provider-default',
					networkAccess: 'provider-default'
				},
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
				cleanup: () => Promise.resolve()
			})
	};
}
