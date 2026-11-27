import { randomUUID } from 'node:crypto';

import type { SandboxOperationContext } from 'pi-bring-your-own-sandbox/provider';
import {
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	UnsupportedSandboxCapabilityError
} from 'pi-bring-your-own-sandbox/provider';
import type {
	TargetFileOperation,
	TargetFileOperations
} from 'pi-bring-your-own-sandbox/provider-kit';
import {
	checkSandboxTargetStatus,
	createTargetFileOperations,
	sandboxTargetTransferLimit
} from 'pi-bring-your-own-sandbox/provider-kit';

import type { DockerClient } from './contracts.js';
import { DOCKER_IMAGE } from './image.js';
import {
	ALLOCATION_LABEL,
	cleanupContext,
	DockerResources
} from './resources.js';
import type { SharedCheckout } from './shared-checkout.js';

export interface DockerFileHelpers {
	readonly files: string;
	readonly search: string;
	readonly matcher: Uint8Array;
}

/**
Serialises fixed filesystem operations in an unprivileged container. Removing
the container cancels an individual call without affecting shell workloads.
*/
export class DockerFileWorker implements TargetFileOperations {
	readonly #resources: DockerResources;
	readonly #client: DockerClient;
	readonly #workspace: {
		readonly mount: string;
		readonly readOnly: boolean;
		readonly shared?: SharedCheckout;
	};
	readonly #helpers: DockerFileHelpers;
	readonly #lifetime: AbortSignal;
	#name: string | undefined;
	#matcherWorker: string | undefined;
	#tail: Promise<unknown> = Promise.resolve();
	#pending = 0;
	#idle: NodeJS.Timeout | undefined;
	#requiresRemoval = false;
	#guardKey: string | undefined;
	readonly files: TargetFileOperations['files'];
	readonly search: TargetFileOperations['search'];

	constructor(
		resources: DockerResources,
		client: DockerClient,
		workspace: {
			readonly mount: string;
			readonly readOnly: boolean;
			readonly shared?: SharedCheckout;
		},
		helpers: DockerFileHelpers,
		lifetime: AbortSignal
	) {
		this.#resources = resources;
		this.#client = client;
		this.#workspace = workspace;
		this.#helpers = helpers;
		this.#lifetime = lifetime;

		const { files, search } = createTargetFileOperations(
			(operation, filename, context, input, requiresWrite) =>
				this.#request(operation, filename, context, input, requiresWrite),
			{
				providerId: 'example.docker',
				backendId: resources.volume,
				recovery: resources.recovery
			}
		);

		this.files = files;
		this.search = search;
	}

	#identity(operation: TargetFileOperation) {
		return {
			operation,
			providerId: 'example.docker',
			backendId: this.#resources.volume,
			recovery: this.#resources.recovery
		};
	}

	async #start(
		context: SandboxOperationContext,
		operation: TargetFileOperation
	): Promise<string> {
		const guards = await this.#workspace.shared?.mounts(
			this.#resources.volume,
			context,
			operation,
			this.#workspace.readOnly
		);

		if (
			this.#requiresRemoval ||
			(this.#name !== undefined && this.#guardKey !== guards?.key)
		) {
			await this.#remove(context, operation);
		}

		if (this.#name !== undefined) {
			return this.#name;
		}

		const name = this.#resources.volume + '-files-' + randomUUID();

		this.#name = name;
		this.#guardKey = guards?.key;
		await this.#resources.checked(
			[
				'create',
				'--name',
				name,
				'--label',
				`${ALLOCATION_LABEL}=${this.#resources.volume}`,
				'--pull=never',
				'--network=none',
				'--read-only',
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				this.#workspace.shared
					? `--user=${String(this.#workspace.shared.uid)}:${String(this.#workspace.shared.gid)}`
					: '--user=65534:65534',
				'--workdir=/workspace',
				'--tmpfs=/opt/pi-byos/node_modules/re2js:rw,noexec,nosuid,nodev,size=1m,mode=0755,uid=65533,gid=65533',
				'--pids-limit=32',
				'--memory=128m',
				'--cpus=1',
				'--log-driver=none',
				'--mount',
				this.#workspace.mount,
				...(guards?.args ?? []),
				'--entrypoint=/bin/sleep',
				DOCKER_IMAGE,
				'infinity'
			],
			context,
			operation
		);
		context.signal.throwIfAborted();
		this.#lifetime.throwIfAborted();
		await this.#resources.checked(['start', name], context, operation);

		return name;
	}

	async #installMatcher(name: string, context: SandboxOperationContext) {
		if (this.#matcherWorker === name) {
			return;
		}

		await this.#resources.checked(
			[
				'exec',
				'--interactive',
				'--user=65533:65533',
				'--workdir=/opt/pi-byos/node_modules/re2js',
				name,
				'/bin/sh',
				'-ec',
				'umask 022; /bin/cat > index.mjs && printf %s \'{"exports":"./index.mjs"}\' > package.json'
			],
			context,
			'grep',
			this.#helpers.matcher
		);
		this.#matcherWorker = name;
	}

	async #remove(
		context: SandboxOperationContext,
		operation: TargetFileOperation | 'dispose'
	): Promise<void> {
		if (this.#name === undefined) {
			return;
		}

		try {
			await this.#resources.removeContainer(
				this.#name,
				cleanupContext(
					operation === 'dispose'
						? {
								operationId: context.operationId,
								reportDiagnostic: context.reportDiagnostic,
								...(context.cleanupBudgets !== undefined && {
									cleanupBudgets: context.cleanupBudgets
								})
							}
						: context
				),
				operation
			);
			this.#name = undefined;
			this.#requiresRemoval = false;
		} catch (error) {
			this.#requiresRemoval = true;

			throw new SandboxCleanupError(
				{
					operation,
					backendId: this.#resources.volume,
					providerId: 'example.docker',
					recovery: this.#resources.recovery
				},
				{ cause: error }
			);
		}
	}

	async #execute(
		operation: TargetFileOperation,
		filename: string,
		context: SandboxOperationContext,
		onDispatch: () => void,
		input?: Uint8Array,
		requiresWrite = false
	): Promise<Uint8Array> {
		const identity = this.#identity(operation);

		const signal = AbortSignal.any([context.signal, this.#lifetime]);

		if (
			context.signal.aborted ||
			this.#lifetime.aborted ||
			context.remainingMs() <= 0
		) {
			throw new SandboxCancelledError({
				...identity,
				reason: 'caller',
				completion: 'not-started'
			});
		}

		const chunks: Uint8Array[] = [];
		let bytes = 0;
		let errorBytes = 0;
		let limitFailure: RangeError | undefined;
		let removal: Promise<void> | undefined;
		let hasDispatched = false;
		const cancel = () => {
			removal ??= this.#remove(context, operation);
			void Promise.allSettled([removal]);
		};

		try {
			const name = await this.#start(context, operation);
			const isSearch = operation === 'find' || operation === 'grep';

			if (
				operation === 'grep' &&
				new URLSearchParams(filename).get('literal') !== 'true'
			) {
				await this.#installMatcher(name, context);
			}

			signal.addEventListener('abort', cancel, { once: true });

			if (signal.aborted) {
				throw new SandboxCancelledError({
					...identity,
					reason: 'caller',
					completion: 'not-started'
				});
			}

			onDispatch();
			hasDispatched = true;

			const result = await this.#client.command({
				args: [
					'exec',
					...(isSearch ? ['--workdir=/opt/pi-byos'] : []),
					...(input === undefined ? [] : ['--interactive']),
					name,
					'/usr/local/bin/node',
					'--input-type=module-typescript',
					'--eval',
					isSearch ? this.#helpers.search : this.#helpers.files,
					'--',
					operation,
					filename,
					String(sandboxTargetTransferLimit),
					isSearch
						? '/workspace'
						: requiresWrite
							? 'write'
							: String(input?.byteLength ?? 0)
				],
				context,
				...(input !== undefined && { input }),
				operation,
				recovery: this.#resources.recovery,
				onOutput(output) {
					if (output.stream === 'stderr') {
						errorBytes += output.data.byteLength;

						if (errorBytes > 64 * 1024) {
							limitFailure = new RangeError(
								'Docker helper diagnostics exceeded 64 KiB.'
							);

							throw limitFailure;
						}

						return;
					}

					bytes += output.data.byteLength;

					if (bytes > sandboxTargetTransferLimit) {
						limitFailure = new RangeError(
							'The file response exceeded the transfer limit.'
						);

						throw limitFailure;
					}

					chunks.push(new Uint8Array(output.data));
				}
			});

			signal.throwIfAborted();

			checkSandboxTargetStatus(result.status, identity);

			return new Uint8Array(Buffer.concat(chunks));
		} catch (error) {
			if (signal.aborted) {
				cancel();
				await removal;

				throw new SandboxCancelledError(
					{
						...identity,
						reason: 'caller',
						completion: hasDispatched ? 'confirmed' : 'not-started'
					},
					{ cause: error }
				);
			}

			if (limitFailure !== undefined) {
				cancel();
				await removal;

				throw new SandboxOperationError(identity, { cause: limitFailure });
			}

			if (!(
				error instanceof SandboxPathNotFoundError ||
				error instanceof SandboxPermissionDeniedError ||
				error instanceof UnsupportedSandboxCapabilityError ||
				error instanceof SandboxOperationError
			)) {
				cancel();
			}

			throw error;
		} finally {
			signal.removeEventListener('abort', cancel);
			await removal;
		}
	}

	#request(
		operation: TargetFileOperation,
		filename: string,
		context: SandboxOperationContext,
		input?: Uint8Array,
		requiresWrite = false
	): Promise<Uint8Array> {
		if (this.#lifetime.aborted) {
			return Promise.reject(new SandboxSessionClosingError({ operation }));
		}

		if (
			this.#workspace.readOnly &&
			(operation === 'mkdir' || operation === 'writeFile' || requiresWrite)
		) {
			return Promise.reject(
				new SandboxPermissionDeniedError(this.#identity(operation))
			);
		}

		clearTimeout(this.#idle);
		this.#pending++;

		const previous = this.#tail;
		const signal = AbortSignal.any([context.signal, this.#lifetime]);
		const queued = Promise.withResolvers<never>();
		const cancelQueued = () => {
			queued.reject(
				new SandboxCancelledError({
					operation,
					providerId: 'example.docker',
					backendId: this.#resources.volume,
					reason: 'caller',
					completion: 'not-started'
				})
			);
		};

		signal.addEventListener('abort', cancelQueued, { once: true });

		if (signal.aborted) {
			cancelQueued();
		}

		const onDispatch = () => {
			signal.removeEventListener('abort', cancelQueued);
		};

		const task = (async () => {
			await previous;

			try {
				return await this.#execute(
					operation,
					filename,
					context,
					onDispatch,
					input,
					requiresWrite
				);
			} finally {
				onDispatch();
				this.#pending--;

				if (
					this.#pending === 0 &&
					!this.#lifetime.aborted &&
					this.#name !== undefined
				) {
					this.#idle = setTimeout(() => {
						this.#tail = Promise.allSettled([this.#remove(context, 'dispose')]);
					}, 30_000).unref();
				}
			}
		})();

		this.#tail = Promise.allSettled([task]);

		return Promise.race([task, queued.promise]);
	}

	async close() {
		clearTimeout(this.#idle);
		await this.#tail;
	}
}
