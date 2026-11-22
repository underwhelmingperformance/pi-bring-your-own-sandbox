import { chown, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	BackendProcessContext,
	SandboxOpenRequest,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';
import {
	closeSandboxSession,
	getSandbox,
	initialiseSandboxHost,
	negotiateSandbox,
	registerSandboxDiagnostics,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';
import { afterEach, expect, it, vi } from 'vitest';

import { FakeClock } from '../../../src/fixtures/clock.js';
import { FixtureConfig } from '../../../src/fixtures/config.js';
import { withPiRuntime } from '../../../src/fixtures/pi-runtime.js';
import { remainingBudget } from '../../../src/fixtures/remaining-budget.js';
import { OperationScope } from '../../../src/lifecycle.js';
import type {
	DockerClient,
	DockerCommand,
	DockerCommandResult,
	DockerConfig
} from '../src/contracts.js';
import dockerExtension from '../src/extension.js';
import { DOCKER_IMAGE } from '../src/image.js';
import { createDockerProvider } from '../src/provider.js';
import { cleanupContext } from '../src/resources.js';

import { writeFakeDockerCli } from './fixtures/fake-cli.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
Puts only a fake Docker CLI on `PATH` while `run` executes, so the extension's
discovery does not depend on the test machine.
*/
async function withFakeDockerCli(run: () => Promise<void>): Promise<void> {
	const tools = await mkdtemp(path.join(tmpdir(), 'byos-docker-cli-'));

	try {
		vi.stubEnv('PATH', path.dirname(await writeFakeDockerCli(tools)));
		vi.stubEnv('BYOS_TEST_ENDPOINT', 'unix:///fixture/docker.sock');
		await run();
	} finally {
		await rm(tools, { recursive: true, force: true });
	}
}

class FakeDocker implements DockerClient {
	readonly commands: DockerCommand[] = [];
	readonly containers = new Set<string>();
	readonly waiting = new Map<string, () => void>();
	info = 'Linux';
	apiVersion = '1.45 1.45';
	mountProbeStatus = 0;
	isVolumePresent = false;
	isRunningProbe = false;
	hasLostRemoval = false;
	status = 0;
	bootstrapStatus = 0;
	imageInspection?: DockerCommandResult;
	runtimeError = '';
	launchFailure: 'not-found' | 'permission-denied' | 'start-failed' | undefined;
	lostCreation: 'volume' | 'container' | undefined;
	readonly pendingAllocations: (() => void)[] = [];

	command(command: DockerCommand): Promise<DockerCommandResult> {
		this.commands.push(command);

		const [operation, ...arguments_] = command.args;

		if (
			operation === 'volume' &&
			arguments_[0] === 'create' &&
			this.lostCreation === 'volume'
		) {
			this.pendingAllocations.push(() => {
				this.isVolumePresent = true;
			});

			return Promise.reject(
				new SandboxTransportError({ operation: command.operation })
			);
		}

		if (operation === 'create' && this.lostCreation === 'container') {
			this.pendingAllocations.push(() => {
				this.containers.add(arguments_[1] ?? 'missing');
			});

			return Promise.reject(
				new SandboxTransportError({ operation: command.operation })
			);
		}

		if (operation === 'image') {
			const id = arguments_.at(-1) ?? '';

			return Promise.resolve(
				this.imageInspection ?? {
					status: 0,
					stdout: Buffer.from(id),
					stderr: Buffer.alloc(0)
				}
			);
		}

		const result = (stdout = '') =>
			Promise.resolve({
				status: 0,
				stdout: new TextEncoder().encode(stdout),
				stderr: new Uint8Array()
			});

		if (operation === 'version') {
			return result(this.apiVersion);
		}

		if (operation === 'info') {
			return result(this.info);
		}

		if (operation === 'volume') {
			if (arguments_[0] === 'create') {
				this.isVolumePresent = true;
			} else if (arguments_[0] === 'rm') {
				this.isVolumePresent = false;
			}

			return result(
				arguments_[0] === 'ls' && this.isVolumePresent
					? this.commands
							.find(
								(entry) =>
									entry.args[0] === 'volume' && entry.args[1] === 'create'
							)
							?.args.at(-1)
					: ''
			);
		}

		if (operation === 'create') {
			this.containers.add(arguments_[1] ?? 'missing');

			return result('container-id');
		}

		if (operation === 'rm') {
			if (this.hasLostRemoval) {
				for (const finish of this.waiting.values()) {
					finish();
				}

				return Promise.reject(new SandboxTransportError({ operation: 'exec' }));
			}

			for (const name of arguments_.slice(1)) {
				this.containers.delete(name);
				this.waiting.get(name)?.();
			}

			return result();
		}

		if (operation === 'container') {
			return result([...this.containers].join('\n'));
		}

		if (operation === 'inspect') {
			const created = this.commands.findLast(
				(entry) => entry.args[0] === 'create'
			);
			const isLauncher = created?.args.includes('--workdir=/') === true;

			return result(
				JSON.stringify({
					Running: false,
					Status: 'exited',
					ExitCode: isLauncher
						? 0
						: created?.args.includes('--entrypoint=/bin/sh')
							? this.mountProbeStatus
							: this.bootstrapStatus,
					Error: isLauncher ? this.runtimeError : ''
				})
			);
		}

		if (operation === 'start' && this.isRunningProbe) {
			return new Promise((resolve) => {
				const name = arguments_.at(-1) ?? 'missing';

				this.waiting.set(name, () => {
					resolve({
						status: 137,
						stdout: new Uint8Array(),
						stderr: new Uint8Array()
					});
				});

				const ready = Buffer.from('ready').toString('base64');
				const frame = JSON.stringify({ kind: 'stdout', data: ready }) + '\n';

				command.onOutput?.({
					stream: 'stdout',
					data: new TextEncoder().encode(frame)
				});
			});
		}

		if (operation === 'start') {
			const created = this.commands.findLast(
				(entry) => entry.args[0] === 'create'
			);

			if (created?.args.includes('--workdir=/') === true) {
				command.onOutput?.({
					stream: 'stdout',
					data: new TextEncoder().encode(
						JSON.stringify(
							this.launchFailure
								? { kind: this.launchFailure }
								: {
										kind: 'exited',
										exit: { kind: 'code', code: this.status }
									}
						) + '\n'
					)
				});
			}
		}

		return result();
	}
}

function context(
	signal = new AbortController().signal
): SandboxOperationContext {
	return {
		reportDiagnostic() {
			return;
		},
		cleanup: {
			deadline: undefined,
			remainingMs: (): undefined => {
				return;
			}
		},
		operationId: 'fixture',
		signal,
		deadline: Date.now() + 5000,
		remainingMs: remainingBudget(5000)
	};
}

const request: SandboxOpenRequest<DockerConfig> = {
	generationId: 'generation',
	sessionId: 'session',
	hostWorkspace: process.cwd(),
	policy: {
		workspaceAccess: 'read-write',
		filesystemScope: 'workspace-only',
		networkAccess: 'denied'
	},
	configuration: {
		executable: '/fixture/docker',
		socketPath: '/fixture/docker.sock'
	}
};

it.each([true, false])(
	'selects the Docker development policy for project trust %s',
	async (projectTrusted) => {
		await withFakeDockerCli(() =>
			withPiRuntime(
				[
					{ name: 'docker', factory: dockerExtension },
					{
						name: 'consumer',
						factory(pi) {
							pi.registerCommand('policy-test', {
								description: 'Read the negotiated policy.',
								async handler(_arguments, context) {
									expect(await negotiateSandbox(pi, context)).toStrictEqual({
										ok: true,
										policy: {
											workspaceAccess: 'read-write',
											filesystemScope: projectTrusted
												? 'provider-default'
												: 'workspace-only',
											networkAccess: projectTrusted
												? 'provider-default'
												: 'denied'
										}
									});
								}
							});
						}
					}
				],
				async (runtime, errors) => {
					await runtime.session.prompt('/policy-test');
					expect(errors).toStrictEqual([]);
				},
				{ projectTrusted }
			)
		);
	}
);

it('reports a missing Docker CLI through status when configuration fails', async () => {
	vi.stubEnv('PATH', '');
	await withPiRuntime(
		[
			{ name: 'docker', factory: dockerExtension },
			{ name: 'diagnostics', factory: registerSandboxDiagnostics }
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/byos status');

			const output = JSON.stringify(
				runtime.session.messages.filter(
					(message) =>
						message.role === 'custom' && message.customType === 'byos'
				)
			);

			expect({
				hasStartupError: errors.length > 0,
				hasFailure: output.includes('InvalidSandboxConfigError'),
				hasDiagnostic: output.includes(
					'Docker: Install the Docker CLI on PATH or set executable to its absolute path.'
				)
			}).toStrictEqual({
				hasStartupError: true,
				hasFailure: true,
				hasDiagnostic: true
			});
		}
	);
});

it.each([
	['Docker Desktop', '1.45 1.45', 0, 'shared'],
	['Linux', '1.52 1.52', 0, 'shared'],
	['Linux', '1.52 1.44', 0, 'copied'],
	['Linux', '1.44 1.52', 0, 'copied'],
	['Linux', '1.52 1.52', 1, 'copied']
] as const)(
	'selects a workspace for %s API %s with mount check %d',
	async (os, api, probe, relationship) => {
		const hostWorkspace = await mkdtemp(path.join(tmpdir(), 'byos-sharing-'));

		try {
			if (process.getuid?.() === 0) {
				await chown(hostWorkspace, 1000, 1000);
				vi.spyOn(process, 'getuid').mockReturnValue(1000);
			}

			if (process.getgid?.() === 0) {
				vi.spyOn(process, 'getgid').mockReturnValue(1000);
			}

			await mkdir(path.join(hostWorkspace, '.pi'));

			const docker = new FakeDocker();

			docker.info = os;
			docker.apiVersion = api;
			docker.mountProbeStatus = probe;

			const provider = createDockerProvider(() => docker);
			const messages: string[] = [];
			const backend = await provider.open(
				{
					...request,
					hostWorkspace,
					policy: {
						workspaceAccess: 'read-write',
						networkAccess: 'provider-default',
						filesystemScope: 'provider-default'
					}
				},
				{
					...context(),
					reportDiagnostic(warning) {
						messages.push(warning.message);
					},
					reportRecovery() {
						return;
					},
					confirmCleanup() {
						return;
					}
				}
			);

			try {
				expect({
					relationship: backend.workspace.relationship,
					version: docker.commands
						.filter((command) => command.args[0] === 'version')
						.map((command) => command.args),
					probed: docker.commands.some((command) =>
						command.args.includes('--entrypoint=/bin/sh')
					)
				}).toStrictEqual({
					relationship,
					version: [
						[
							'version',
							'--format',
							'{{.Client.APIVersion}} {{.Server.APIVersion}}'
						]
					],
					probed: !api.includes('1.44')
				});
				expect(
					messages.some((message) => message.includes('private copy'))
				).toBe(relationship === 'copied');
			} finally {
				await backend.dispose(context());
			}
		} finally {
			vi.restoreAllMocks();
			await rm(hostWorkspace, { recursive: true, force: true });
		}
	}
);

it('declines an explicit shared checkout for a root Pi process before allocation', async () => {
	const docker = new FakeDocker();
	const provider = createDockerProvider(() => docker);
	const uid = vi.spyOn(process, 'getuid').mockReturnValue(0);

	try {
		await expect(
			provider.open(
				{
					...request,
					policy: {
						workspaceAccess: 'read-write',
						filesystemScope: 'provider-default',
						networkAccess: 'provider-default',
						workspaceRelationship: 'shared'
					}
				},
				{
					...context(),
					reportRecovery() {
						throw new Error('Unexpected allocation');
					},
					confirmCleanup() {
						return;
					}
				}
			)
		).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
		expect(docker.commands).toStrictEqual([]);
	} finally {
		uid.mockRestore();
	}
});

it('reports confirmed broker cleanup after Docker opening releases partial allocations', async () => {
	const docker = new FakeDocker();

	docker.bootstrapStatus = 1;

	const config = new FixtureConfig();

	await withPiRuntime(
		[
			{
				name: 'docker',
				factory(pi) {
					initialiseSandboxHost(pi, {});
					config.activate(
						pi,
						createDockerProvider(() => docker)
					);
					pi.registerCommand('open-test', {
						description: 'Exercise failed opening.',
						async handler(_arguments, context) {
							await expect(getSandbox(pi, context)).rejects.toMatchObject({
								name: 'SandboxOperationError'
							});
							expect({
								report: await closeSandboxSession(pi, context),
								containers: docker.containers,
								hasVolume: docker.isVolumePresent
							}).toStrictEqual({
								report: { confirmed: true, recoveries: [], failures: [] },
								containers: new Set(),
								hasVolume: false
							});
						}
					});
				}
			},
			{
				name: 'execution-settings',
				factory: (pi) => {
					config.bind(pi);
				}
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/open-test');
			expect(errors).toStrictEqual([]);
		},
		{
			prepare(_directory, _runtimeDirectory) {
				config.set({
					provider: 'example.docker',
					policy: request.policy,
					providerConfig: request.configuration
				});
			}
		}
	);
});

it.each([
	{ workspaceRelationship: 'remote' },
	{ workspaceRelationship: 'shared' },
	{ workspaceProtection: [{ kind: 'path', path: '.pi' }] }
] as const)('rejects policy %j before contacting Docker', async (policy) => {
	const docker = new FakeDocker();
	const provider = createDockerProvider(() => docker);

	await expect(
		provider.open(
			{
				...request,
				policy: { ...request.policy, ...policy }
			},
			{
				...context(),
				confirmCleanup() {
					return;
				},
				reportRecovery: () => {
					throw new Error('No allocation should be reported.');
				}
			}
		)
	).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
	expect(docker.commands).toStrictEqual([]);
});

it.each([
	['provider-default', 'provider-default', 'read-write'],
	['provider-default', 'denied', 'read-write'],
	['workspace-only', 'provider-default', 'read-write'],
	['provider-default', 'provider-default', 'read-only']
] as const)(
	'reports the effective isolation for a %s/%s/%s copy',
	async (filesystemScope, networkAccess, workspaceAccess) => {
		const docker = new FakeDocker();
		const provider = createDockerProvider(() => docker);
		const backend = await provider.open(
			{
				...request,
				policy: {
					filesystemScope,
					networkAccess,
					workspaceAccess,
					workspaceRelationship: 'copied'
				}
			},
			{
				...context(),
				confirmCleanup() {
					return;
				},
				reportRecovery() {
					return;
				}
			}
		);

		expect(backend.workspace.relationship).toBe('copied');
		expect(backend.policy).toStrictEqual({
			workspaceRelationship: 'copied',
			workspaceAccess,
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		});
		await backend.dispose(context());
	}
);

it('uses literal argv, isolated mounts and explicit target environment overrides', async () => {
	const docker = new FakeDocker();
	const provider = createDockerProvider(() => docker);
	const recoveries: unknown[] = [];
	const backend = await provider.open(request, {
		...context(),
		confirmCleanup() {
			return;
		},
		reportRecovery(recovery) {
			recoveries.push(recovery);
		}
	});

	docker.status = 7;

	const outcome = await backend.exec(
		{
			kind: 'argv',
			executable: '/bin/printf',
			args: ['$HOME', '; exit 99'],
			cwd: 'nested',
			env: { FIXTURE_VALUE: 'target' }
		},
		{
			...context(),
			onOutput: () => {
				throw new Error('No output was expected.');
			}
		}
	);
	const created = docker.commands.findLast(
		(entry) => entry.args[0] === 'create'
	)?.args;

	expect({
		outcome,
		capabilities: backend.capabilities,
		workspace: backend.workspace,
		recoveries
	}).toStrictEqual({
		outcome: { kind: 'exited', exit: { kind: 'code', code: 7 } },
		capabilities: {
			processKinds: ['argv', 'shell'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: [
				'exec',
				'files.read',
				'files.write',
				'files.list',
				'search.find',
				'search.grep',
				'copy'
			],
			shells: ['sh', 'bash']
		},
		workspace: {
			root: '/workspace',
			pathFlavor: 'posix',
			relationship: 'copied',
			home: '/tmp',
			defaultShell: 'sh',
			description:
				'The host workspace is copied on opening. Changes remain in a generation-owned Docker volume until disposal.'
		},
		recoveries: [backend.recovery]
	});

	if (backend.recovery.kind !== 'allocation') {
		throw new Error('The Docker provider must report an allocation.');
	}

	const jobName: unknown = expect.stringMatching(/^pi-byos-[a-f\d-]+$/);
	const launcher: unknown = expect.any(String);
	const invocation: unknown = JSON.parse(created?.at(-1) ?? '{}');

	expect({
		args: created?.slice(0, -3),
		launcher: created?.at(-3),
		separator: created?.at(-2),
		invocation
	}).toStrictEqual({
		args: [
			'create',
			'--name',
			jobName,
			'--label',
			`io.pi-byos.reference=${backend.recovery.id}`,
			'--pull=never',
			'--network=none',
			'--read-only',
			'--cap-drop=ALL',
			'--cap-add=SETUID',
			'--cap-add=SETGID',
			'--cap-add=DAC_OVERRIDE',
			'--security-opt=no-new-privileges',
			'--pids-limit=64',
			'--memory=128m',
			'--cpus=1',
			'--log-driver=none',
			'--user=0:0',
			'--workdir=/',
			'--tmpfs=/tmp:rw,nosuid,nodev,size=16m',
			'--mount',
			`"type=volume","source=${backend.recovery.id}","target=/workspace","volume-nocopy"`,
			'--entrypoint=/usr/local/bin/node',
			DOCKER_IMAGE,
			'--input-type=module-typescript',
			'--eval'
		],
		launcher,
		separator: '--',
		invocation: {
			executable: '/bin/printf',
			args: ['$HOME', '; exit 99'],
			cwd: '/workspace/nested',
			env: { FIXTURE_VALUE: 'target' }
		}
	});
	await backend.dispose(context());
	expect({
		containers: docker.containers,
		hasVolume: docker.isVolumePresent
	}).toStrictEqual({ containers: new Set(), hasVolume: false });
});

it('confirms cancellation through daemon removal before permitting another job', async () => {
	const docker = new FakeDocker();
	const backend = await createDockerProvider(() => docker).open(request, {
		...context(),
		confirmCleanup() {
			return;
		},
		reportRecovery: (recovery) => {
			expect(recovery.kind).toBe('allocation');
		}
	});

	docker.isRunningProbe = true;

	const controller = new AbortController();
	const operation: BackendProcessContext = {
		...context(controller.signal),
		onOutput() {
			controller.abort();
		}
	};
	const result = await backend.exec(
		{ kind: 'argv', executable: '/bin/sleep', args: ['60'] },
		operation
	);

	expect({ result, containers: docker.containers }).toStrictEqual({
		result: { kind: 'cancelled', termination: 'confirmed' },
		containers: new Set()
	});
	docker.isRunningProbe = false;
	await backend.dispose(context());
});

it('uses the broker cleanup deadline for cancelled Docker jobs', async () => {
	const docker = new FakeDocker();
	const backend = await createDockerProvider(() => docker).open(request, {
		...context(),
		confirmCleanup() {
			return;
		},
		reportRecovery() {
			return;
		}
	});
	const controller = new AbortController();
	const deadline = Date.now() + 12_000;
	const cleanupRemaining = remainingBudget(12_000);

	docker.isRunningProbe = true;

	try {
		const outcome = await backend.exec(
			{ kind: 'argv', executable: '/bin/sleep', args: ['60'] },
			{
				...context(controller.signal),
				cleanup: {
					remainingMs: () =>
						controller.signal.aborted ? cleanupRemaining() : undefined,
					get deadline() {
						return controller.signal.aborted ? deadline : undefined;
					}
				},
				onOutput() {
					controller.abort();
				}
			}
		);
		const cleanup = docker.commands.filter(
			(command) => command.operation === 'exec' && command.args[0] === 'rm'
		);

		expect({
			outcome,
			deadlines: cleanup.map((command) => ({
				execution: command.context.deadline,
				cleanup: command.context.cleanup.deadline
			}))
		}).toStrictEqual({
			outcome: { kind: 'cancelled', termination: 'confirmed' },
			deadlines: [{ execution: deadline, cleanup: deadline }]
		});
	} finally {
		docker.isRunningProbe = false;
		await backend.dispose(context());
	}
});

it('reports unconfirmed termination when the client finishes but the daemon cannot remove the job', async () => {
	const docker = new FakeDocker();
	const backend = await createDockerProvider(() => docker).open(request, {
		...context(),
		confirmCleanup() {
			return;
		},
		reportRecovery: () => {
			return;
		}
	});

	docker.isRunningProbe = true;
	docker.hasLostRemoval = true;

	const controller = new AbortController();
	const outcome = await backend.exec(
		{ kind: 'argv', executable: '/bin/sleep', args: ['60'] },
		{
			...context(controller.signal),
			onOutput() {
				controller.abort();
			}
		}
	);

	expect({ outcome, hasContainer: docker.containers.size > 0 }).toStrictEqual({
		outcome: { kind: 'cancelled', termination: 'unconfirmed' },
		hasContainer: true
	});
	docker.hasLostRemoval = false;
	docker.isRunningProbe = false;
	await backend.dispose(context());
});

it('releases a partial allocation when copying the workspace fails', async () => {
	const docker = new FakeDocker();

	docker.bootstrapStatus = 1;

	const reported: unknown[] = [];
	let failure: unknown;

	try {
		await createDockerProvider(() => docker).open(request, {
			...context(),
			confirmCleanup() {
				return;
			},
			reportRecovery(recovery) {
				reported.push(recovery);
			}
		});
	} catch (error) {
		failure = error;
	}

	const expectedFailure: unknown = expect.objectContaining({
		name: 'SandboxOperationError',
		operation: 'open',
		recovery: reported[0]
	});

	expect({
		failure,
		hasRecovery: reported.length === 1,
		containers: docker.containers,
		hasVolume: docker.isVolumePresent
	}).toStrictEqual({
		failure: expectedFailure,
		hasRecovery: true,
		containers: new Set(),
		hasVolume: false
	});
});

it.each(['volume', 'container'] as const)(
	'keeps %s creation uncertain after an empty cleanup query',
	async (kind) => {
		const docker = new FakeDocker();

		docker.lostCreation = kind;

		let confirmations = 0;
		const recoveries: unknown[] = [];
		let failure: unknown;

		try {
			await createDockerProvider(() => docker).open(request, {
				...context(),
				confirmCleanup() {
					confirmations++;
				},
				reportRecovery(recovery) {
					recoveries.push(recovery);
				}
			});
		} catch (error) {
			failure = error;
		}

		const before = {
			containers: docker.containers.size,
			hasVolume: docker.isVolumePresent
		};

		for (const allocate of docker.pendingAllocations) {
			allocate();
		}

		const expectedFailure: unknown = expect.objectContaining({
			name: 'SandboxCleanupError',
			recovery: recoveries[0]
		});

		expect({
			failure,
			confirmations,
			recoveries: recoveries.length,
			before,
			after: {
				containers: docker.containers.size,
				hasVolume: docker.isVolumePresent
			}
		}).toStrictEqual({
			failure: expectedFailure,
			confirmations: 0,
			recoveries: 1,
			before: { containers: 0, hasVolume: false },
			after: {
				containers: kind === 'container' ? 1 : 0,
				hasVolume: kind === 'volume'
			}
		});
	}
);

it('updates an already-running removal when cancellation publishes a longer deadline', async () => {
	const docker = new FakeDocker();
	const backend = await createDockerProvider(() => docker).open(request, {
		...context(),
		confirmCleanup() {
			return;
		},
		reportRecovery() {
			return;
		}
	});
	const command = docker.command.bind(docker);
	const removing = Promise.withResolvers<DockerCommand>();
	const release = Promise.withResolvers<undefined>();

	docker.command = async (received) => {
		if (received.args[0] === 'rm' && received.operation === 'exec') {
			removing.resolve(received);
			await release.promise;
		}

		return command(received);
	};

	const controller = new AbortController();
	const deadline = Date.now() + 12_000;
	const cleanupRemaining = remainingBudget(12_000);
	const running = backend.exec(
		{ kind: 'argv', executable: '/bin/true', args: [] },
		{
			...context(controller.signal),
			cleanup: {
				remainingMs: () =>
					controller.signal.aborted ? cleanupRemaining() : undefined,
				get deadline() {
					return controller.signal.aborted ? deadline : undefined;
				}
			},
			onOutput() {
				return;
			}
		}
	);

	try {
		const removal = await removing.promise;

		controller.abort();
		release.resolve(undefined);
		expect({
			outcome: await running,
			deadline: removal.context.deadline,
			cleanupDeadline: removal.context.cleanup.deadline,
			isAborted: removal.context.signal.aborted
		}).toStrictEqual({
			outcome: { kind: 'cancelled', termination: 'confirmed' },
			deadline,
			cleanupDeadline: deadline,
			isAborted: false
		});
	} finally {
		release.resolve(undefined);
		await running;
		await backend.dispose(context());
	}
});

it.each([-1_000_000, 1_000_000])(
	'keeps one cleanup budget across sequential commands at wall time %s',
	(wallTime) => {
		const clock = new FakeClock();
		const caller = new AbortController();
		const scope = new OperationScope(
			{ operation: 'exec' },
			caller.signal,
			{},
			30_000,
			{ cancellationGraceMs: 8000, disposalTimeoutMs: 10_000 },
			clock
		);

		try {
			const first = cleanupContext(scope.context, 'first', clock.monotonicNow);

			clock.advance(1000);
			clock.wallTime = wallTime;
			caller.abort();
			clock.advance(2500);

			const second = cleanupContext(
				scope.context,
				'second',
				clock.monotonicNow
			);

			expect({
				first: first.remainingMs(),
				second: second.remainingMs(),
				cleanup: first.cleanup.remainingMs(),
				isAborted: first.signal.aborted
			}).toStrictEqual({
				first: 5500,
				second: 5500,
				cleanup: 5500,
				isAborted: false
			});

			clock.advance(6000);
			expect([first.remainingMs(), second.remainingMs()]).toStrictEqual([0, 0]);
		} finally {
			scope.dispose();
		}
	}
);

it.each(['session', 'socket', 'backend'])(
	'rejects a copy with a mismatched %s before allocation',
	async (field) => {
		const docker = new FakeDocker();
		const provider = createDockerProvider(() => docker);
		const opening = {
			...context(),
			reportRecovery() {
				return;
			},
			confirmCleanup() {
				return;
			}
		};
		const parent = await provider.open(request, opening);

		try {
			if (!provider.copy) {
				throw new Error('Expected Docker copy support.');
			}

			const before = docker.commands.length;

			await expect(
				provider.copy(
					{
						...request,
						sessionId: field === 'session' ? 'different' : request.sessionId,
						configuration: {
							...request.configuration,
							socketPath:
								field === 'socket'
									? '/different'
									: request.configuration.socketPath
						},
						policy: { ...request.policy, workspaceAccess: 'read-only' },
						source: {
							kind: 'backend',
							backend:
								field === 'backend' ? { ...parent, id: parent.id } : parent
						}
					},
					opening
				)
			).rejects.toMatchObject({
				name: 'StaleSandboxHandleError',
				operation: 'open'
			});
			expect(docker.commands.slice(before)).toStrictEqual([]);
		} finally {
			await parent.dispose(context());
		}
	}
);

it('accepts a copy as the source of another copy', async () => {
	const docker = new FakeDocker();
	const provider = createDockerProvider(() => docker);

	if (!provider.copy) {
		throw new Error('Expected Docker copy support.');
	}

	const opening = {
		...context(),
		reportRecovery() {
			return;
		},
		confirmCleanup() {
			return;
		}
	};
	const copyRequest = {
		...request,
		policy: { ...request.policy, workspaceAccess: 'read-only' as const }
	};
	const parent = await provider.open(request, opening);
	const first = await provider.copy(
		{ ...copyRequest, source: { kind: 'backend', backend: parent } },
		opening
	);

	try {
		const second = await provider.copy(
			{ ...copyRequest, source: { kind: 'backend', backend: first } },
			opening
		);

		await second.dispose(context());
	} finally {
		await first.dispose(context());
		await parent.dispose(context());
	}
});

it('advertises PowerShell only for a trusted image selected by immutable ID', () => {
	const image = 'sha256:' + 'a'.repeat(64);

	expect(
		createDockerProvider({ powerShellImage: image }).capabilities.shells
	).toStrictEqual(['sh', 'bash', 'powershell']);
	expect(createDockerProvider().capabilities.shells).toStrictEqual([
		'sh',
		'bash'
	]);
	expect(() =>
		createDockerProvider({ powerShellImage: 'local:latest' })
	).toThrow('immutable Docker image ID');
});

it.each([
	'missing image',
	'missing image with warning',
	'id mismatch',
	'invalid id',
	'daemon unavailable',
	'start-failed',
	'runtime failure',
	'not-found',
	'permission-denied',
	'nonzero',
	'available'
] as const)(
	'checks the optional Docker PowerShell runtime during open: %s',
	async (mode) => {
		const docker = new FakeDocker();

		docker.runtimeError =
			mode === 'runtime failure' ? 'Failed to start OCI runtime' : '';
		docker.launchFailure =
			mode === 'not-found' ||
			mode === 'permission-denied' ||
			mode === 'start-failed'
				? mode
				: undefined;
		docker.status = mode === 'nonzero' ? 7 : 0;

		const powerShellImage = 'sha256:' + 'a'.repeat(64);
		const isMissing =
			mode === 'missing image' || mode === 'missing image with warning';
		const isTransport =
			mode === 'daemon unavailable' ||
			mode === 'id mismatch' ||
			mode === 'invalid id';
		const otherId = 'sha256:' + 'b'.repeat(64);

		if (isMissing || isTransport) {
			const messages = {
				'missing image':
					'Error response from daemon: No such image: ' + powerShellImage,
				'missing image with warning':
					'WARNING: Could not load Docker config.\nError: No such image: ' +
					powerShellImage,
				'daemon unavailable': 'Daemon connection refused',
				'id mismatch': '',
				'invalid id': ''
			};

			docker.imageInspection = {
				status: mode === 'id mismatch' || mode === 'invalid id' ? 0 : 1,
				stdout: Buffer.from(mode === 'id mismatch' ? otherId : ''),
				stderr: Buffer.from(messages[mode])
			};
		}

		const provider = createDockerProvider({
			createClient: () => docker,
			powerShellImage
		});
		const diagnostics: unknown[] = [];
		const pending = provider.open(request, {
			...context(),
			reportDiagnostic(entry) {
				diagnostics.push(entry);
			},
			reportRecovery() {
				return;
			},
			confirmCleanup() {
				return;
			}
		});

		if (mode !== 'available') {
			await expect(pending).rejects.toMatchObject({
				name: isTransport
					? 'SandboxTransportError'
					: mode === 'start-failed' || mode === 'runtime failure'
						? 'SandboxOperationError'
						: 'UnsupportedSandboxCapabilityError',
				operation: 'open'
			});

			if (isTransport) {
				const cause =
					mode === 'id mismatch'
						? 'Docker reported image ' +
							otherId +
							' for ' +
							powerShellImage +
							'.'
						: mode === 'invalid id'
							? 'Docker image inspect returned an invalid image ID.'
							: 'Docker image inspect failed with status 1.';

				await expect(pending).rejects.toMatchObject({
					cause: { message: cause }
				});
			}

			expect(docker.isVolumePresent).toBe(false);

			const diagnostic = isMissing
				? 'Build the configured PowerShell image on the selected Docker daemon before opening the workspace.'
				: mode === 'not-found' ||
					  mode === 'permission-denied' ||
					  mode === 'nonzero'
					? 'The selected Docker toolchain must provide executable PowerShell 7 or later at /opt/powershell/pwsh.'
					: undefined;

			expect(diagnostics).toStrictEqual(
				diagnostic ? [{ level: 'warning', message: diagnostic }] : []
			);

			if (isMissing) {
				expect(docker.commands.map((command) => command.args)).toStrictEqual([
					['image', 'inspect', '--format', '{{.Id}}', powerShellImage]
				]);
			}

			return;
		}

		const backend = await pending;

		try {
			await backend.exec(
				{ kind: 'shell', dialect: 'powershell', command: 'exit 0' },
				{
					...context(),
					onOutput() {
						return;
					}
				}
			);

			const jobs = docker.commands
				.filter(
					(command) =>
						command.args[0] === 'create' &&
						command.args.includes(powerShellImage)
				)
				.map((command) => JSON.parse(command.args.at(-1) ?? 'null') as unknown);

			expect(jobs).toStrictEqual(
				['if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }', 'exit 0'].map(
					(command) => ({
						cwd: '/workspace',
						env: {},
						executable: '/opt/powershell/pwsh',
						args: [
							'-NoLogo',
							'-NoProfile',
							'-NonInteractive',
							'-Command',
							command
						]
					})
				)
			);
		} finally {
			await backend.dispose(context());
		}
	}
);

it('builds the optional toolchain on the pinned Docker job image by default', async () => {
	const dockerfile = await readFile(
		new URL('../src/powershell/Dockerfile', import.meta.url),
		'utf8'
	);

	expect(dockerfile.split('\n')).toContain('ARG NODE_IMAGE=' + DOCKER_IMAGE);
});
