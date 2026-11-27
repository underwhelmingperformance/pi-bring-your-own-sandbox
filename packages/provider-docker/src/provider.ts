import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import type {
	BackendFiles,
	BackendProcessContext,
	BackendProcessOutcome,
	BackendSearch,
	GrantedPath,
	ProcessRequest,
	Profile,
	SandboxBackend,
	SandboxCapabilities,
	SandboxCopySource,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxOperationContext,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/provider';
import {
	isSandboxError,
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxTransportError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/provider';
import {
	resolveSandboxCopySource,
	SandboxLaunchFrames,
	targetFileHelper,
	targetSearchHelper
} from 'pi-bring-your-own-sandbox/provider-kit';

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
import { DOCKER_IMAGE } from './image.js';
import { readDockerMatcher } from './matcher.js';
import {
	ALLOCATION_LABEL,
	cleanupContext,
	DockerResources
} from './resources.js';
import { mount, SharedCheckout } from './shared-checkout.js';

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
		'search.grep',
		'copy'
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

interface CopyOwner {
	readonly provider: symbol;
	readonly sessionId: string;
	readonly socketPath: string;
}

class DockerBackend implements SandboxBackend {
	static readonly copiedDescription =
		'Jobs use a copied workspace, a read-only Debian image, private scratch space, UID 65534 and no network. Host files outside the copied workspace are not mounted.';
	readonly #shared: SharedCheckout | undefined;
	readonly #resources: DockerResources;
	readonly #owner: CopyOwner;
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

	readonly profile: Profile;
	readonly grantedPaths?: readonly GrantedPath[];
	readonly recovery: SandboxBackend['recovery'];
	readonly policyDescription: string;

	constructor(
		resources: DockerResources,
		profile: Profile,
		grantedPaths: readonly GrantedPath[],
		launcher: string,
		client: DockerClient,
		helpers: DockerFileHelpers,
		owner: CopyOwner,
		image: string,
		source?: SandboxCopySource,
		shared?: SharedCheckout
	) {
		this.#shared = shared;
		this.profile = profile;
		this.policyDescription = shared
			? 'Jobs use the live checkout and the container image. Host paths outside the checkout are unavailable. Container networking is disabled.'
			: DockerBackend.copiedDescription;

		if (grantedPaths.length > 0) {
			this.grantedPaths = grantedPaths;
		}

		this.workspace = shared
			? {
					...copiedWorkspace,
					relationship: 'shared',
					description:
						'Live host checkout. Authorised edits are visible to the developer immediately.'
				}
			: source === undefined
				? copiedWorkspace
				: {
						...copiedWorkspace,
						description:
							source.kind === 'host'
								? 'Private copy of the host checkout.'
								: 'Private copy of another Docker workspace.'
					};
		this.#owner = owner;
		this.#image = image;
		this.#resources = resources;
		this.#launcher = launcher;
		this.id = resources.volume;
		this.recovery = resources.recovery;
		this.#worker = new DockerFileWorker(
			resources,
			client,
			{
				mount: this.#mount(this.#isWorkspaceReadOnly()),
				readOnly: this.#isWorkspaceReadOnly(),
				...(shared && { shared })
			},
			helpers,
			this.#lifetime.signal
		);
		this.search = this.#worker.search;
		this.files = this.#worker.files;
	}

	#isWorkspaceReadOnly(): boolean {
		return (
			this.#shared !== undefined && !this.profile.policy.hostWorkspaceWrites
		);
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
		context.reportWarning(
			'The selected Docker toolchain must provide executable PowerShell 7 or later at /opt/powershell/pwsh.'
		);

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
			env: request.env ?? {},
			...(this.#shared && {
				identity: { uid: this.#shared.uid, gid: this.#shared.gid }
			})
		};
		const guards = await this.#shared?.mounts(
			this.id,
			context,
			operation,
			this.#isWorkspaceReadOnly()
		);
		const frames = new SandboxLaunchFrames(context.onOutput, {
			operation,
			providerId: 'example.docker',
			recovery: this.recovery
		});
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
				this.#mount(this.#isWorkspaceReadOnly()),
				...(guards?.args ?? []),
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

	async #import(
		sourceMount: string,
		importer: string,
		context: SandboxOpenContext
	) {
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

		if (copied.exit.kind === 'code' && copied.exit.code === 0) {
			return;
		}

		const failures = new Map([
			[42, 'The workspace changed during the Docker import.'],
			[43, 'The Docker workspace exceeds the snapshot import limits.'],
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

		context.reportWarning(message);

		throw new SandboxOperationError(
			{
				operation: 'open',
				providerId: 'example.docker',
				recovery: this.recovery
			},
			{ cause: new Error(message) }
		);
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

	belongsTo(owner: CopyOwner): boolean {
		return (
			!this.#lifetime.signal.aborted &&
			this.#owner.provider === owner.provider &&
			this.#owner.sessionId === owner.sessionId &&
			this.#owner.socketPath === owner.socketPath
		);
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
					...(this.#shared
						? [
								'--driver',
								'local',
								'--opt',
								'type=none',
								'--opt',
								'o=bind',
								'--opt',
								'device=' + this.#shared.root
							]
						: []),
					'--label',
					`${ALLOCATION_LABEL}=${this.#resources.volume}`,
					this.#resources.volume
				],
				context,
				'open'
			);

			if (this.#shared) {
				const guards = await this.#shared.mounts(
					this.id,
					context,
					'open',
					this.#isWorkspaceReadOnly()
				);
				const probe = await this.#resources.job(
					[
						'--pull=never',
						'--network=none',
						'--read-only',
						'--cap-drop=ALL',
						'--security-opt=no-new-privileges',
						'--user=' +
							String(this.#shared.uid) +
							':' +
							String(this.#shared.gid),
						'--mount',
						sourceMount,
						'--mount',
						this.#mount(this.#isWorkspaceReadOnly()),
						...guards.args,
						'--entrypoint=/bin/sh',
						DOCKER_IMAGE,
						'-c',
						'test /workspace -ef /source && test "$(stat -c %u /workspace)" = "$(id -u)" && ' +
							(this.#isWorkspaceReadOnly()
								? 'test ! -w /workspace'
								: 'test -w /workspace') +
							' && test ! -w /workspace/.pi'
					],
					{
						...context,
						onOutput() {
							return;
						}
					},
					'open'
				);

				if (probe.kind === 'cancelled') {
					throw new SandboxCancelledError({
						operation: 'open',
						reason: 'caller',
						completion:
							probe.termination === 'confirmed' ? 'confirmed' : 'unknown',
						recovery: this.recovery
					});
				}

				if (probe.exit.kind !== 'code' || probe.exit.code !== 0) {
					context.reportWarning(
						'Docker could not verify the selected access to the live checkout and read-only access to .pi.'
					);

					throw new UnsupportedSandboxPolicyError({
						operation: 'open',
						providerId: 'example.docker'
					});
				}
			} else {
				await this.#import(sourceMount, importer, context);
			}

			if (this.profile.shells.includes('powershell')) {
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
			!this.profile.shells.includes(request.dialect)
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

export function dockerProviderDeclaration(powerShellImage?: string) {
	const capabilities: SandboxCapabilities =
		powerShellImage === undefined
			? defaultCapabilities
			: {
					...defaultCapabilities,
					shells: [...defaultCapabilities.shells, 'powershell']
				};
	const restricted: Profile = {
		policy: {
			hostWorkspaceWrites: false,
			network: false,
			hostUserData: 'denied',
			hostSystemFiles: 'denied'
		},
		capabilities: capabilities.operations,
		processKinds: capabilities.processKinds,
		shells: capabilities.shells,
		exitStatus: capabilities.exitStatus,
		terminationScope: capabilities.terminationScope
	};
	const profiles = {
		open: [
			restricted,
			{
				...restricted,
				policy: { ...restricted.policy, hostWorkspaceWrites: true }
			}
		],
		copy: [restricted]
	};

	return { id: 'example.docker', label: 'Docker reference provider', profiles };
}

/**
Creates the optional Docker example provider. Connection validation is synchronous;
opening allocates a workspace volume on a local Unix-socket daemon.
Use an immutable image ID to add PowerShell, or supply a client factory for tests.
*/
export function createDockerProvider(
	options: DockerProviderOptions | ((config: DockerConfig) => DockerClient) = {}
) {
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

	const declaration = dockerProviderDeclaration(powerShellImage);
	const { profiles } = declaration;
	const image = powerShellImage ?? DOCKER_IMAGE;

	const provider = Symbol('Docker provider');

	async function allocate(
		request: SandboxOpenRequest<DockerConfig>,
		context: SandboxOpenContext,
		source?: SandboxCopySource
	): Promise<SandboxBackend> {
		const profile = (source === undefined ? profiles.open : profiles.copy).find(
			(candidate) =>
				candidate.policy.hostWorkspaceWrites ===
				request.profile.policy.hostWorkspaceWrites
		);

		if (
			profile === undefined ||
			request.profile.policy.network ||
			request.profile.policy.hostUserData !== 'denied' ||
			request.profile.policy.hostSystemFiles !== 'denied'
		) {
			throw new UnsupportedSandboxPolicyError({
				operation: 'open',
				providerId: 'example.docker'
			});
		}

		const owner = {
			provider,
			sessionId: request.sessionId,
			socketPath: request.configuration.socketPath
		};
		const parent =
			source === undefined
				? undefined
				: resolveSandboxCopySource(
						source,
						(backend): backend is DockerBackend =>
							backend instanceof DockerBackend && backend.belongsTo(owner)
					);

		const client =
			createClient?.(request.configuration) ??
			new NodeDockerClient(request.configuration);

		const choice =
			source === undefined
				? await SharedCheckout.select(request.hostWorkspace, client, context)
				: undefined;

		if (typeof choice === 'string') {
			context.reportWarning(choice);

			throw new UnsupportedSandboxPolicyError({
				operation: 'open',
				providerId: 'example.docker'
			});
		}

		const shared = choice;

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
				context.reportWarning(
					'Build the configured PowerShell image on the selected Docker daemon before opening the workspace.'
				);

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

		const sourceExtension = import.meta.filename.endsWith('.ts') ? 'ts' : 'js';
		const [launcher, files, search, importer, matcher] = await Promise.all([
			readFile(new URL(`launcher.${sourceExtension}`, import.meta.url), 'utf8'),
			targetFileHelper(),
			targetSearchHelper(),
			readFile(
				new URL(`import-helper.${sourceExtension}`, import.meta.url),
				'utf8'
			),
			readDockerMatcher()
		]);

		const root = await realpath(request.hostWorkspace);
		const grantedPaths = (['read', 'write'] as const).flatMap((kind) =>
			(request.paths?.[kind] ?? []).map((hostPath) => ({
				kind,
				hostPath,
				targetPath: path.posix.resolve(
					'/workspace',
					...path.relative(root, hostPath).split(path.sep)
				)
			}))
		);
		const resources = new DockerResources(
			client,
			request.configuration.socketPath
		);
		const backend = new DockerBackend(
			resources,
			profile,
			grantedPaths,
			launcher,
			client,
			{ files, search, matcher },
			owner,
			image,
			source,
			shared
		);

		if (parent === undefined) {
			await backend.initialise(
				mount(['type=bind', `source=${root}`, 'target=/source', 'readonly']),
				importer,
				context
			);
		} else {
			await parent.copyInto(backend, importer, context);
		}

		return backend;
	}

	return {
		...declaration,
		validateConfig: dockerConfig,
		open: (request, context) => allocate(request, context),
		copy: (request, context) => allocate(request, context, request.source)
	} satisfies SandboxProvider<DockerConfig>;
}
