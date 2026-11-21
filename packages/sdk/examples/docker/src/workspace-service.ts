import { lstat, mkdir, realpath, rmdir, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
	SandboxOpenContext,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';
import {
	SandboxCleanupError,
	SandboxOperationError
} from 'pi-bring-your-own-sandbox/api';

import type { DockerConfig } from './contracts.js';
import { connectHostReplacements } from './host-replacements.js';
import { DOCKER_IMAGE } from './image.js';
import {
	ALLOCATION_LABEL,
	cleanupContext,
	DockerResources
} from './resources.js';
import { mount } from './workspace-mount.js';

interface MountRequest {
	readonly workspace: string;
	readonly bootstrap: string;
	readonly access: 'read-only' | 'read-write';
	readonly protectedPaths: readonly string[];
}

export class DockerWorkspaceService {
	static async open(
		config: DockerConfig,
		resources: DockerResources,
		request: MountRequest,
		context: SandboxOpenContext
	) {
		const workspace = await realpath(request.workspace);
		const result = await resources.checked(
			['info', '--format', '{{json .SecurityOptions}}'],
			context,
			'open'
		);
		const security: unknown = JSON.parse(
			new TextDecoder().decode(result.stdout)
		);

		if (
			!Array.isArray(security) ||
			security.some((value) => typeof value !== 'string')
		) {
			throw new TypeError('Docker returned invalid security options.');
		}

		const service = new DockerWorkspaceService(
			resources,
			request,
			security.includes('name=apparmor'),
			workspace
		);

		context.reportRecovery(resources.recovery);

		try {
			await service.#start(config, request, context);
			context.signal.throwIfAborted();

			return service;
		} catch (error) {
			try {
				await service.dispose(cleanupContext(context));
			} catch (error_) {
				throw new SandboxCleanupError(
					{
						operation: 'open',
						providerId: 'example.docker',
						recovery: resources.recovery
					},
					{
						cause: new AggregateError(
							[error, error_],
							'Docker could not clean up the workspace mount after opening failed.'
						)
					}
				);
			}

			context.confirmCleanup();

			throw error;
		}
	}

	readonly #hostWorkspace: string;
	#stagingIdentity: { dev: bigint; ino: bigint } | undefined;
	#closeHost: (() => Promise<void>) | undefined;
	readonly resources: DockerResources;
	readonly bootstrap: string;
	readonly hasAppArmor: boolean;

	private constructor(
		resources: DockerResources,
		request: MountRequest,
		hasAppArmor: boolean,
		workspace: string
	) {
		this.resources = resources;
		this.bootstrap = request.bootstrap;
		this.hasAppArmor = hasAppArmor;
		this.#hostWorkspace = workspace;
	}

	async #start(
		config: DockerConfig,
		request: MountRequest,
		context: SandboxOpenContext
	) {
		const resources = this.resources;
		const workspace = this.#hostWorkspace;
		const owner = await stat(workspace, { bigint: true });
		const staging = this.resources.hostStaging;

		if (staging === undefined && request.protectedPaths.length > 0) {
			throw new Error('Protected paths require the native host service.');
		}

		if (staging !== undefined) {
			if (
				process.platform !== 'darwin' ||
				request.access !== 'read-write' ||
				path.dirname(workspace) === workspace ||
				path.dirname(staging) !== path.dirname(workspace)
			) {
				throw new Error(
					'Native staging requires a directory beside the macOS checkout.'
				);
			}

			await mkdir(staging, { mode: 0o700 });

			const created = await lstat(staging, { bigint: true });

			this.#stagingIdentity = { dev: created.dev, ino: created.ino };

			if (created.dev !== owner.dev) {
				throw new Error(
					'Native staging and the workspace must use the same filesystem.'
				);
			}
		}

		if (
			staging === undefined &&
			process.platform === 'darwin' &&
			request.access === 'read-write'
		) {
			throw new Error('Writable macOS mounts require native staging.');
		}

		const credentials = String(owner.uid) + ':' + String(owner.gid);
		const label = ALLOCATION_LABEL + '=' + resources.volume;
		const control = mount([
			'type=volume',
			'source=' + resources.volume,
			'target=/control'
		]);

		await resources.checked(
			['volume', 'create', '--label', label, resources.volume],
			context,
			'open'
		);

		const setup = await resources.job(
			[
				'--pull=never',
				'--read-only',
				'--network=none',
				'--security-opt=no-new-privileges',
				'--cap-drop=ALL',
				'--cap-add=CHOWN',
				'--mount',
				control,
				DOCKER_IMAGE,
				'chown',
				credentials,
				'/control'
			],
			{
				...context,
				onOutput() {
					return;
				}
			},
			'open'
		);

		if (
			setup.kind !== 'exited' ||
			setup.exit.kind !== 'code' ||
			setup.exit.code !== 0
		) {
			context.signal.throwIfAborted();

			throw new SandboxOperationError(
				{
					operation: 'open',
					providerId: 'example.docker',
					recovery: resources.recovery
				},
				{
					cause: new Error(
						'Docker could not initialise the workspace control volume.'
					)
				}
			);
		}

		await resources.checked(
			[
				'create',
				'--name',
				resources.volume,
				'--label',
				label,
				'--pull=never',
				'--read-only',
				'--network=none',
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				'--pids-limit=32',
				'--memory=128m',
				'--cpus=1',
				'--user=' + credentials,
				'--mount',
				control,
				'--mount',
				mount([
					'type=bind',
					'source=' + this.bootstrap,
					'target=/mount-check',
					'readonly'
				]),
				'--mount',
				mount([
					'type=bind',
					'source=' + workspace,
					'target=/backing',
					...(staging !== undefined || request.access === 'read-only'
						? ['readonly']
						: [])
				]),
				...(staging === undefined
					? []
					: [
							'--mount',
							mount(['type=bind', 'source=' + staging, 'target=/staging'])
						]),
				'--entrypoint=/mount-check',
				DOCKER_IMAGE,
				...(staging === undefined ? ['serve', request.access] : ['serve-host'])
			],
			context,
			'open'
		);
		await resources.checked(['start', resources.volume], context, 'open');
		await resources.checked(
			[
				'exec',
				resources.volume,
				'/usr/bin/timeout',
				'5',
				'/bin/sh',
				'-ec',
				'while [ ! -S /control/service ]; do sleep 0.05; done'
			],
			context,
			'open'
		);

		if (staging !== undefined) {
			this.#closeHost = await connectHostReplacements(
				config,
				resources.volume,
				workspace,
				staging,
				request.protectedPaths
			);
		}
	}

	get controlVolume() {
		return this.resources.volume;
	}

	async dispose(context: SandboxOperationContext) {
		await this.#closeHost?.();
		await this.resources.dispose(context);

		if (
			this.resources.hostStaging === undefined ||
			this.#stagingIdentity === undefined
		) {
			return;
		}

		const entry = await lstat(this.resources.hostStaging, { bigint: true });

		if (
			!entry.isDirectory() ||
			entry.ino !== this.#stagingIdentity.ino ||
			entry.dev !== this.#stagingIdentity.dev
		) {
			throw new SandboxCleanupError({
				operation: 'dispose',
				providerId: 'example.docker',
				recovery: this.resources.recovery
			});
		}

		await rmdir(this.resources.hostStaging);
		this.#stagingIdentity = undefined;
	}
}
