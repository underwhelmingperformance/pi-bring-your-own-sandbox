import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest,
	SandboxBackend,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxOperationContext,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/api';
import {
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxOperationError,
	SandboxSessionClosingError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/api';

import { NodeDockerClient } from './client.js';
import { dockerConfig as dockerConfig } from './config.js';
import type {
	DockerClient,
	DockerConfig,
	TargetInvocation
} from './contracts.js';
import { DeadlineTimer } from './deadline.js';
import { LaunchFrames } from './frames.js';
import { DOCKER_IMAGE } from './image.js';
import { ALLOCATION_LABEL, DockerResources } from './resources.js';

function mount(fields: readonly string[]): string {
	return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(',');
}

class DockerBackend implements SandboxBackend {
	readonly #resources: DockerResources;
	readonly #launcher: string;
	readonly #lifetime = new AbortController();
	readonly #active = new Set<Promise<BackendProcessOutcome>>();
	#closing: Promise<void> | undefined;
	readonly id: string;
	readonly workspace = {
		root: '/workspace',
		pathFlavor: 'posix',
		relationship: 'copied',
		home: '/tmp',
		defaultShell: 'sh',
		description:
			'The host workspace is copied on opening. Changes remain in a generation-owned Docker volume until disposal.'
	} as const;
	readonly capabilities = {
		processKinds: ['argv', 'shell'],
		exitStatus: 'guaranteed',
		operations: ['exec'],
		shells: ['sh', 'bash']
	} as const;
	readonly policy: SandboxBackend['policy'];
	readonly recovery: SandboxBackend['recovery'];
	readonly policyDescription =
		'Jobs use a copied workspace, a read-only Debian image, private scratch space, UID 65534 and no network. Host files outside the copied workspace are not mounted.';

	constructor(
		resources: DockerResources,
		policy: SandboxBackend['policy'],
		launcher: string
	) {
		this.#resources = resources;
		this.#launcher = launcher;
		this.id = resources.volume;
		this.recovery = resources.recovery;
		this.policy = { ...policy };
	}

	#mount(isReadOnly: boolean): string {
		return mount([
			'type=volume',
			`source=${this.#resources.volume}`,
			'target=/workspace',
			'volume-nocopy',
			...(isReadOnly ? ['readonly'] : [])
		]);
	}

	async #run(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		const invocation: TargetInvocation = {
			executable:
				request.kind === 'argv'
					? request.executable
					: request.dialect === 'bash'
						? '/bin/bash'
						: '/bin/sh',
			args: request.kind === 'argv' ? request.args : ['-c', request.command],
			cwd: path.posix.resolve('/workspace', request.cwd ?? '.'),
			env: request.env ?? {}
		};
		const frames = new LaunchFrames(context.onOutput, this.recovery);
		// A different launcher UID prevents the child from writing control frames through /proc.
		const result = await this.#resources.job(
			[
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
				this.#mount(this.policy.workspaceAccess === 'read-only'),
				'--entrypoint=/usr/local/bin/node',
				DOCKER_IMAGE,
				'--input-type=module-typescript',
				'--eval',
				this.#launcher,
				'--',
				JSON.stringify(invocation)
			],
			{
				...context,
				signal: AbortSignal.any([context.signal, this.#lifetime.signal]),
				onOutput: (output) => {
					frames.accept(output);
				}
			},
			'exec'
		);

		return result.kind === 'cancelled' ? result : frames.finish();
	}

	async #dispose(context: SandboxOperationContext): Promise<void> {
		const expired = Promise.withResolvers<never>();

		const fail = () => {
			expired.reject(
				new SandboxCleanupError({
					operation: 'dispose',
					providerId: 'example.docker',
					backendId: this.id,
					recovery: this.recovery
				})
			);
		};

		const timer = new DeadlineTimer(context.deadline, fail);

		context.signal.addEventListener('abort', fail, { once: true });

		if (context.signal.aborted) {
			fail();
		}

		try {
			await Promise.race([Promise.allSettled(this.#active), expired.promise]);
		} finally {
			timer.dispose();
			context.signal.removeEventListener('abort', fail);
		}

		await this.#resources.dispose(context);
	}

	async initialise(
		hostWorkspace: string,
		context: SandboxOpenContext
	): Promise<void> {
		context.reportRecovery(this.recovery);

		if (context.signal.aborted) {
			throw new SandboxCancelledError({
				operation: 'open',
				reason: 'caller',
				completion: 'not-started'
			});
		}

		try {
			await this.#resources.checked(
				[
					'volume',
					'create',
					'--label',
					`${ALLOCATION_LABEL}=${this.#resources.volume}`,
					this.#resources.volume
				],
				context,
				'open'
			);

			const source = await realpath(hostWorkspace);
			const copied = await this.#resources.job(
				[
					'--pull=never',
					'--network=none',
					'--read-only',
					'--cap-drop=ALL',
					'--cap-add=CHOWN',
					'--cap-add=DAC_OVERRIDE',
					'--cap-add=FOWNER',
					'--security-opt=no-new-privileges',
					'--mount',
					this.#mount(false),
					'--mount',
					mount([
						'type=bind',
						`source=${source}`,
						'target=/source',
						'readonly'
					]),
					'--entrypoint=/bin/sh',
					DOCKER_IMAGE,
					'-c',
					'cp -a /source/. /workspace/ && chown -R 65534:65534 /workspace'
				],
				{
					...context,
					onOutput: () => {
						return;
					}
				},
				'open'
			);

			if (copied.kind === 'cancelled') {
				throw new SandboxCancelledError({
					operation: 'open',
					reason: 'caller',
					completion:
						copied.termination === 'confirmed' ? 'confirmed' : 'unknown',
					recovery: this.recovery
				});
			}

			if (copied.exit.kind !== 'code' || copied.exit.code !== 0) {
				throw new SandboxOperationError({
					operation: 'open',
					providerId: 'example.docker',
					recovery: this.recovery
				});
			}
		} catch (error) {
			try {
				await this.#resources.dispose({
					operationId: `${context.operationId}:failed-open`,
					signal: new AbortController().signal,
					deadline: Date.now() + 5000
				});
			} catch (error_) {
				throw new SandboxCleanupError(
					{
						operation: 'open',
						providerId: 'example.docker',
						recovery: this.recovery
					},
					{
						cause: new AggregateError(
							[error, error_],
							'Docker opening and cleanup failed.'
						)
					}
				);
			}

			context.confirmCleanup();

			throw error;
		}
	}

	exec(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		if (this.#closing !== undefined) {
			return Promise.reject(
				new SandboxSessionClosingError({
					operation: 'exec',
					providerId: 'example.docker',
					backendId: this.id
				})
			);
		}

		if (
			request.kind === 'shell' &&
			request.dialect !== 'sh' &&
			request.dialect !== 'bash'
		) {
			return Promise.reject(
				new UnsupportedSandboxCapabilityError({
					operation: 'exec',
					providerId: 'example.docker',
					backendId: this.id
				})
			);
		}

		const running = this.#run(request, context);

		this.#active.add(running);
		void Promise.allSettled([running]).then(() => {
			this.#active.delete(running);
		});

		return running;
	}

	dispose(context: SandboxOperationContext): Promise<void> {
		if (this.#closing !== undefined) {
			return this.#closing;
		}

		this.#lifetime.abort();
		this.#closing = this.#dispose(context);

		return this.#closing;
	}
}

/**
Creates the optional Docker example provider. Connection validation is synchronous;
opening allocates a copied workspace volume on a local Unix-socket daemon.
Pass a client factory to test daemon failures without allocating containers.
*/
export function createDockerProvider(
	createClient?: (config: DockerConfig) => DockerClient
): SandboxProvider<DockerConfig> {
	return {
		id: 'example.docker',
		label: 'Docker reference provider',
		protocolVersion: 1,
		capabilities: {
			processKinds: ['argv', 'shell'],
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: ['sh', 'bash']
		},
		policies: {
			workspaceAccess: ['read-only', 'read-write'],
			filesystemScope: ['workspace-only'],
			networkAccess: ['denied']
		},
		validateConfig: dockerConfig,
		async open(
			request: SandboxOpenRequest<DockerConfig>,
			context: SandboxOpenContext
		) {
			if (
				request.policy.filesystemScope !== 'workspace-only' ||
				request.policy.networkAccess !== 'denied'
			) {
				throw new UnsupportedSandboxPolicyError({
					operation: 'open',
					providerId: 'example.docker'
				});
			}

			const client =
				createClient?.(request.configuration) ??
				new NodeDockerClient(request.configuration);
			const launcher = await readFile(
				new URL('launcher.ts', import.meta.url),
				'utf8'
			);
			const backend = new DockerBackend(
				new DockerResources(client, request.configuration.socketPath),
				request.policy,
				launcher
			);

			await backend.initialise(request.hostWorkspace, context);

			return backend;
		}
	};
}
