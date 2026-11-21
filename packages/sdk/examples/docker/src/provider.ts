import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
	BackendFiles,
	BackendProcessContext,
	BackendProcessOutcome,
	BackendSearch,
	ProcessRequest,
	ReviewSnapshotSource,
	SandboxBackend,
	SandboxCapabilities,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxOperationContext,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/api';
import {
	isSandboxError,
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxTransportError,
	StaleSandboxHandleError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/api';

import { NodeDockerClient } from './client.js';
import { dockerConfig } from './config.js';
import type {
	DockerClient,
	DockerConfig,
	TargetInvocation
} from './contracts.js';
import { DeadlineTimer } from './deadline.js';
import type { DockerFileHelpers } from './file-worker.js';
import { DockerFileWorker } from './file-worker.js';
import { LaunchFrames } from './frames.js';
import { DOCKER_IMAGE } from './image.js';
import { readDockerMatcher } from './matcher.js';
import {
	ALLOCATION_LABEL,
	cleanupContext,
	DockerResources
} from './resources.js';

function mount(fields: readonly string[]): string {
	return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(',');
}

function targetCommand(
	request: ProcessRequest
): Pick<TargetInvocation, 'executable' | 'args'> {
	if (request.kind === 'argv') {
		return { executable: request.executable, args: request.args };
	}

	if (request.dialect === 'powershell') {
		return {
			executable: '/opt/powershell/pwsh',
			args: [
				'-NoLogo',
				'-NoProfile',
				'-NonInteractive',
				'-Command',
				request.command
			]
		};
	}

	return {
		executable: request.dialect === 'bash' ? '/bin/bash' : '/bin/sh',
		args: ['-c', request.command]
	};
}

const copiedWorkspace = {
	root: '/workspace',
	pathFlavor: 'posix',
	relationship: 'copied',
	home: '/tmp',
	defaultShell: 'sh',
	description:
		'The host workspace is copied on opening. Changes remain in a generation-owned Docker volume until disposal.'
} as const;

const defaultCapabilities = {
	processKinds: ['argv', 'shell'],
	terminationScope: 'workload',
	exitStatus: 'guaranteed',
	operations: [
		'exec',
		'files.read',
		'files.write',
		'files.list',
		'search.find',
		'search.grep'
	],
	shells: ['sh', 'bash']
} as const;

export interface DockerProviderOptions {
	readonly createClient?: (config: DockerConfig) => DockerClient;
	/**
	Immutable ID of the optional trusted image with /opt/powershell/pwsh.
	*/
	readonly powerShellImage?: string;
}

class DockerBackend implements SandboxBackend {
	readonly #resources: DockerResources;
	readonly #onClose: () => void;
	readonly #snapshots = new Set<Promise<void>>();
	readonly #launcher: string;
	readonly #image: string;
	readonly #lifetime = new AbortController();
	readonly #active = new Set<Promise<BackendProcessOutcome>>();
	#closing: Promise<void> | undefined;
	readonly #worker: DockerFileWorker;
	readonly files: BackendFiles;
	readonly search: BackendSearch;
	readonly id: string;
	readonly workspace: SandboxBackend['workspace'];

	readonly capabilities: SandboxCapabilities;
	readonly policy: SandboxBackend['policy'];
	readonly recovery: SandboxBackend['recovery'];
	readonly policyDescription =
		'Jobs use a copied workspace, a read-only Debian image, private scratch space, UID 65534 and no network. Host files outside the copied workspace are not mounted.';

	constructor(
		resources: DockerResources,
		policy: SandboxBackend['policy'],
		launcher: string,
		client: DockerClient,
		helpers: DockerFileHelpers,
		onClose: () => void,
		toolchain: { image: string; capabilities: SandboxCapabilities },
		source?: ReviewSnapshotSource
	) {
		this.workspace =
			source === undefined
				? copiedWorkspace
				: {
						...copiedWorkspace,
						description:
							source.kind === 'host'
								? 'Read-only snapshot of the host checkout.'
								: 'Read-only snapshot of the proposed command’s Docker workspace.'
					};
		this.#onClose = onClose;
		this.#image = toolchain.image;
		this.capabilities = toolchain.capabilities;
		this.#resources = resources;
		this.#launcher = launcher;
		this.id = resources.volume;
		this.recovery = resources.recovery;
		this.#worker = new DockerFileWorker(
			resources,
			client,
			{
				mount: this.#mount(policy.workspaceAccess === 'read-only'),
				readOnly: policy.workspaceAccess === 'read-only'
			},
			helpers,
			this.#lifetime.signal
		);
		this.search = {
			find: this.#worker.find.bind(this.#worker),
			grep: this.#worker.grep.bind(this.#worker)
		};
		this.files = {
			read: this.#worker,
			list: this.#worker,
			write: {
				access: this.#worker.writeAccess.bind(this.#worker),
				mkdir: this.#worker.mkdir.bind(this.#worker),
				writeFile: this.#worker.writeFile.bind(this.#worker)
			}
		};
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

	#powerShellFailure(context: SandboxOpenContext, cause?: unknown) {
		context.reportDiagnostic({
			level: 'warning',
			message:
				'The selected Docker toolchain must provide executable PowerShell 7 or later at /opt/powershell/pwsh.'
		});

		return new UnsupportedSandboxCapabilityError(
			{ operation: 'open', providerId: 'example.docker' },
			{ cause }
		);
	}

	async #checkPowerShell(context: SandboxOpenContext) {
		let probe: BackendProcessOutcome;

		try {
			probe = await this.#run(
				{
					kind: 'shell',
					dialect: 'powershell',
					command: 'if ($PSVersionTable.PSVersion.Major -lt 7) { exit 1 }'
				},
				{
					...context,
					onOutput() {
						return;
					}
				},
				'open'
			);
		} catch (error) {
			if (
				!isSandboxError(error, SandboxPathNotFoundError) &&
				!isSandboxError(error, SandboxPermissionDeniedError)
			) {
				throw error;
			}

			throw this.#powerShellFailure(context, error);
		}

		if (probe.kind === 'cancelled') {
			throw new SandboxCancelledError({
				operation: 'open',
				reason: 'caller',
				completion: probe.termination === 'confirmed' ? 'confirmed' : 'unknown',
				recovery: this.recovery
			});
		}

		if (probe.exit.kind !== 'code' || probe.exit.code !== 0) {
			throw this.#powerShellFailure(context);
		}
	}

	async #run(
		request: ProcessRequest,
		context: BackendProcessContext,
		operation: 'open' | 'exec' = 'exec'
	): Promise<BackendProcessOutcome> {
		const invocation: TargetInvocation = {
			...targetCommand(request),
			cwd: path.posix.resolve('/workspace', request.cwd ?? '.'),
			env: request.env ?? {}
		};
		const frames = new LaunchFrames(context.onOutput, this.recovery, operation);
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
				this.#image,
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
			operation
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

		const timer = new DeadlineTimer(context.remainingMs, fail);

		context.signal.addEventListener('abort', fail, { once: true });

		if (context.signal.aborted) {
			fail();
		}

		try {
			await Promise.race([
				Promise.allSettled([
					...this.#active,
					...this.#snapshots,
					this.#worker.close()
				]),
				expired.promise
			]);
		} finally {
			timer.dispose();
			context.signal.removeEventListener('abort', fail);
		}

		if (context.remainingMs() <= 0) {
			fail();
			await expired.promise;
		}

		await this.#resources.dispose(context);
	}

	async copyInto(
		backend: DockerBackend,
		importer: string,
		context: SandboxOpenContext
	): Promise<void> {
		if (this.#lifetime.signal.aborted) {
			throw new SandboxSessionClosingError({
				operation: 'open',
				backendId: this.id
			});
		}

		const signal = AbortSignal.any([context.signal, this.#lifetime.signal]);
		const copying = backend.initialise(
			mount([
				'type=volume',
				`source=${this.id}`,
				'target=/source',
				'readonly',
				'volume-nocopy'
			]),
			importer,
			{
				...context,
				signal
			}
		);

		this.#snapshots.add(copying);

		try {
			await copying;
		} catch (error) {
			if (
				error instanceof SandboxCancelledError &&
				signal.aborted &&
				!context.signal.aborted
			) {
				throw new SandboxCancelledError(
					{
						operation: 'open',
						providerId: 'example.docker',
						backendId: this.id,
						reason: 'shutdown',
						completion: error.completion,
						...(error.recovery !== undefined && { recovery: error.recovery })
					},
					{ cause: error }
				);
			}

			throw error;
		} finally {
			this.#snapshots.delete(copying);
		}
	}

	async initialise(
		sourceMount: string,
		importer: string,
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
					sourceMount,
					'--pids-limit=32',
					'--memory=256m',
					'--cpus=1',
					'--log-driver=none',
					'--entrypoint=/usr/local/bin/node',
					DOCKER_IMAGE,
					'--input-type=module-typescript',
					'--eval',
					importer
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
				const failures = new Map([
					[42, 'The workspace changed during the Docker import.'],
					[43, 'The Docker workspace exceeds the snapshot import limits.'],
					[44, 'A regular file has a hard link outside the workspace.'],
					[45, 'A workspace entry has a filename that is not valid UTF-8.'],
					[
						46,
						'Docker could not read or copy a workspace entry. Check permissions and available space.'
					]
				]);
				const message =
					(copied.exit.kind === 'code'
						? failures.get(copied.exit.code)
						: undefined) ??
					'The Docker workspace importer stopped before it finished.';

				context.reportDiagnostic({ level: 'warning', message });

				throw new SandboxOperationError(
					{
						operation: 'open',
						providerId: 'example.docker',
						recovery: this.recovery
					},
					{ cause: new Error(message) }
				);
			}

			if (this.capabilities.shells.includes('powershell')) {
				await this.#checkPowerShell(context);
			}
		} catch (error) {
			try {
				await this.#resources.dispose(
					cleanupContext(context, `${context.operationId}:failed-open`)
				);
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
			!this.capabilities.shells.includes(request.dialect)
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

		this.#onClose();
		this.#lifetime.abort();
		this.#closing = this.#dispose(context);

		return this.#closing;
	}
}

/**
Creates the optional Docker example provider. Connection validation is synchronous;
opening allocates a copied workspace volume on a local Unix-socket daemon.
Use an immutable image ID to add PowerShell, or supply a client factory for tests.
*/
export function createDockerProvider(
	options: DockerProviderOptions | ((config: DockerConfig) => DockerClient) = {}
): SandboxProvider<DockerConfig> {
	const { createClient, powerShellImage } =
		typeof options === 'function'
			? { createClient: options, powerShellImage: undefined }
			: options;

	if (
		powerShellImage !== undefined &&
		!/^sha256:[a-f0-9]{64}$/u.test(powerShellImage)
	) {
		throw new TypeError(
			'Select the PowerShell runtime by its immutable Docker image ID.'
		);
	}

	const capabilities: SandboxCapabilities =
		powerShellImage === undefined
			? defaultCapabilities
			: {
					...defaultCapabilities,
					shells: [...defaultCapabilities.shells, 'powershell']
				};
	const toolchain = { image: powerShellImage ?? DOCKER_IMAGE, capabilities };

	const active = new Map<
		string,
		{
			backend: DockerBackend;
			generationId: string;
			sessionId: string;
			socketPath: string;
		}
	>();

	async function allocate(
		request: SandboxOpenRequest<DockerConfig>,
		context: SandboxOpenContext,
		source?: ReviewSnapshotSource
	) {
		if (
			request.policy.filesystemScope !== 'workspace-only' ||
			request.policy.networkAccess !== 'denied' ||
			(request.policy.workspaceRelationship !== undefined &&
				request.policy.workspaceRelationship !== 'copied') ||
			(request.policy.workspaceProtection?.length ?? 0) > 0 ||
			(source !== undefined && request.policy.workspaceAccess !== 'read-only')
		) {
			throw new UnsupportedSandboxPolicyError({
				operation: 'open',
				providerId: 'example.docker'
			});
		}

		const parent =
			source?.kind === 'sandbox' ? active.get(source.backendId) : undefined;

		if (
			source?.kind === 'sandbox' &&
			(parent === undefined ||
				source.providerId !== 'example.docker' ||
				source.generationId !== parent.generationId ||
				parent.sessionId !== request.sessionId ||
				parent.socketPath !== request.configuration.socketPath)
		) {
			throw new StaleSandboxHandleError({ operation: 'open' });
		}

		const client =
			createClient?.(request.configuration) ??
			new NodeDockerClient(request.configuration);

		if (powerShellImage !== undefined) {
			const inspected = await client.command({
				args: ['image', 'inspect', '--format', '{{.Id}}', powerShellImage],
				context,
				operation: 'open',
				recovery: { kind: 'none' }
			});

			const output = new TextDecoder();
			const missing = 'No such image: ' + powerShellImage;
			const messages = output.decode(inspected.stderr).split(/\r?\n/);

			if (
				inspected.status !== 0 &&
				messages.some(
					(line) =>
						line === 'Error response from daemon: ' + missing ||
						line === 'Error: ' + missing
				)
			) {
				context.reportDiagnostic({
					level: 'warning',
					message:
						'Build the configured PowerShell image on the selected Docker daemon before opening the workspace.'
				});

				throw new UnsupportedSandboxCapabilityError({
					operation: 'open',
					providerId: 'example.docker'
				});
			}

			const reportedId = output.decode(inspected.stdout).trim();

			if (reportedId !== powerShellImage || inspected.status !== 0) {
				const reason =
					inspected.status === 0
						? /^sha256:[0-9a-f]{64}$/.test(reportedId)
							? 'Docker reported image ' +
								reportedId +
								' for ' +
								powerShellImage +
								'.'
							: 'Docker image inspect returned an invalid image ID.'
						: 'Docker image inspect failed with status ' +
							String(inspected.status) +
							'.';

				throw new SandboxTransportError(
					{ operation: 'open', providerId: 'example.docker' },
					{ cause: new Error(reason) }
				);
			}
		}

		const [launcher, files, search, importer, matcher] = await Promise.all([
			readFile(new URL('launcher.ts', import.meta.url), 'utf8'),
			readFile(new URL('file-helper.ts', import.meta.url), 'utf8'),
			readFile(new URL('search-helper.ts', import.meta.url), 'utf8'),
			readFile(new URL('import-helper.ts', import.meta.url), 'utf8'),
			readDockerMatcher()
		]);
		const resources = new DockerResources(
			client,
			request.configuration.socketPath
		);
		const backend = new DockerBackend(
			resources,
			request.policy,
			launcher,
			client,
			{ files, search, matcher },
			() => {
				active.delete(resources.volume);
			},
			toolchain,
			source
		);

		if (parent === undefined) {
			const host = await realpath(request.hostWorkspace);

			await backend.initialise(
				mount(['type=bind', `source=${host}`, 'target=/source', 'readonly']),
				importer,
				context
			);
		} else {
			await parent.backend.copyInto(backend, importer, context);
		}

		if (source === undefined) {
			active.set(backend.id, {
				backend,
				generationId: request.generationId,
				sessionId: request.sessionId,
				socketPath: request.configuration.socketPath
			});
		}

		return backend;
	}

	return {
		id: 'example.docker',
		defaultPolicy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		},
		label: 'Docker reference provider',
		protocolVersion: 1,
		capabilities,
		policies: {
			workspaceRelationship: ['copied'],
			workspaceAccess: ['read-only', 'read-write'],
			filesystemScope: ['workspace-only'],
			networkAccess: ['denied']
		},
		validateConfig: dockerConfig,
		open: (request, context) => allocate(request, context),
		openReviewSnapshot: (request, context) =>
			allocate(request, context, request.source)
	};
}
