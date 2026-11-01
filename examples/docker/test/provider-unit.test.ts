import type {
	BackendProcessContext,
	SandboxOpenRequest,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';
import {
	closeSandboxSession,
	getSandbox,
	initialiseSandboxHost,
	registerSandboxProvider,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { withPiRuntime } from '../../../src/fixtures/pi-runtime.js';
import type {
	DockerClient,
	DockerCommand,
	DockerCommandResult,
	DockerConfig
} from '../src/contracts.js';
import { DOCKER_IMAGE } from '../src/image.js';
import { createDockerProvider } from '../src/provider.js';

class FakeDocker implements DockerClient {
	readonly commands: DockerCommand[] = [];
	readonly containers = new Set<string>();
	readonly waiting = new Map<string, () => void>();
	isVolumePresent = false;
	isRunningProbe = false;
	hasLostRemoval = false;
	status = 0;
	bootstrapStatus = 0;
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

		const result = (stdout = '') =>
			Promise.resolve({
				status: 0,
				stdout: new TextEncoder().encode(stdout),
				stderr: new Uint8Array()
			});

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
			const isLauncher =
				created?.args.includes('--entrypoint=/usr/local/bin/node') === true;

			return result(
				JSON.stringify({
					Running: false,
					Status: 'exited',
					ExitCode: isLauncher ? 0 : this.bootstrapStatus,
					Error: ''
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

			if (created?.args.includes('--entrypoint=/usr/local/bin/node') === true) {
				command.onOutput?.({
					stream: 'stdout',
					data: new TextEncoder().encode(
						JSON.stringify({
							kind: 'exited',
							exit: { kind: 'code', code: this.status }
						}) + '\n'
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
	return { operationId: 'fixture', signal, deadline: Date.now() + 5000 };
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

it('reports confirmed broker cleanup after Docker opening releases partial allocations', async () => {
	const docker = new FakeDocker();

	docker.bootstrapStatus = 1;

	let agentDirectory = '';

	await withPiRuntime(
		[
			{
				name: 'docker',
				factory(pi) {
					initialiseSandboxHost(pi, { agentDirectory });
					registerSandboxProvider(
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
			}
		],
		async (runtime, errors) => {
			await runtime.session.prompt('/open-test');
			expect(errors).toStrictEqual([]);
		},
		{
			async prepare(_directory, runtimeDirectory) {
				agentDirectory = runtimeDirectory;
				await writeFile(
					path.join(agentDirectory, 'byos.json'),
					JSON.stringify({
						provider: 'example.docker',
						policy: request.policy,
						providerConfig: request.configuration
					})
				);
			}
		}
	);
});

it('rejects an unsupported policy before contacting Docker', async () => {
	const docker = new FakeDocker();
	const provider = createDockerProvider(() => docker);

	await expect(
		provider.open(
			{
				...request,
				policy: { ...request.policy, networkAccess: 'provider-default' }
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
		capabilities: { operations: ['exec'], shells: ['sh', 'bash'] },
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
import { writeFile } from 'node:fs/promises';
import path from 'node:path';

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
