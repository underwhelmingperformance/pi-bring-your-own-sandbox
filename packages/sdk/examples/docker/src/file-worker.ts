import { randomUUID } from 'node:crypto';

import type {
	BackendFileReader,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';
import {
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import type { DockerClient } from './contracts.js';
import { DOCKER_IMAGE } from './image.js';
import {
	ALLOCATION_LABEL,
	cleanupContext,
	DockerResources
} from './resources.js';

const statValidator = Compile(
	Type.Object({
		kind: Type.Enum(['file', 'directory', 'other']),
		size: Type.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })
	})
);
const transferLimit = 16 * 1024 * 1024;

const entrySchema = Type.Object({
	name: Type.String(),
	kind: Type.Enum(['file', 'directory', 'symlink', 'other'])
});
const listValidator = Compile(Type.Array(entrySchema));

type FileOperation =
	'mkdir' | 'listDirectory' | 'writeFile' | 'readFile' | 'stat' | 'access';

/**
Serialises fixed filesystem operations in an unprivileged container. Removing
the container cancels an individual call without affecting shell workloads.
*/
export class DockerFileWorker implements BackendFileReader {
	readonly #resources: DockerResources;
	readonly #client: DockerClient;
	readonly #workspace: { readonly mount: string; readonly readOnly: boolean };
	readonly #helper: string;
	readonly #lifetime: AbortSignal;
	#name: string | undefined;
	#tail: Promise<unknown> = Promise.resolve();
	#pending = 0;
	#idle: NodeJS.Timeout | undefined;
	#cleanupFailure: SandboxCleanupError | undefined;

	constructor(
		resources: DockerResources,
		client: DockerClient,
		workspace: { readonly mount: string; readonly readOnly: boolean },
		helper: string,
		lifetime: AbortSignal
	) {
		this.#resources = resources;
		this.#client = client;
		this.#workspace = workspace;
		this.#helper = helper;
		this.#lifetime = lifetime;
	}

	async #start(context: SandboxOperationContext): Promise<string> {
		if (this.#name !== undefined) {
			return this.#name;
		}

		const name = this.#resources.volume + '-files-' + randomUUID();

		this.#name = name;
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
				'--user=65534:65534',
				'--workdir=/workspace',
				'--pids-limit=32',
				'--memory=128m',
				'--cpus=1',
				'--log-driver=none',
				'--mount',
				this.#workspace.mount,
				'--entrypoint=/bin/sleep',
				DOCKER_IMAGE,
				'infinity'
			],
			context,
			'exec'
		);
		await this.#resources.checked(['start', name], context, 'exec');

		return name;
	}

	async #remove(context: SandboxOperationContext): Promise<void> {
		if (this.#name === undefined) {
			return;
		}

		try {
			await this.#resources.removeContainer(
				this.#name,
				cleanupContext(context),
				'exec'
			);
			this.#name = undefined;
		} catch (error) {
			this.#cleanupFailure = new SandboxCleanupError(
				{
					operation: 'dispose',
					providerId: 'example.docker',
					recovery: this.#resources.recovery
				},
				{ cause: error }
			);

			throw this.#cleanupFailure;
		}
	}

	async #execute(
		operation: FileOperation,
		filename: string,
		context: SandboxOperationContext,
		input?: Uint8Array,
		requiresWrite = false
	): Promise<Uint8Array> {
		if (this.#cleanupFailure !== undefined) {
			throw this.#cleanupFailure;
		}

		const identity = {
			operation,
			providerId: 'example.docker',
			backendId: this.#resources.volume,
			recovery: this.#resources.recovery
		};

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
		let removal: Promise<void> | undefined;
		const cancel = () => {
			removal ??= this.#remove(context);
			void Promise.allSettled([removal]);
		};

		try {
			const name = await this.#start(context);

			signal.addEventListener('abort', cancel, { once: true });

			if (signal.aborted) {
				throw new SandboxCancelledError({
					...identity,
					reason: 'caller',
					completion: 'not-started'
				});
			}

			const result = await this.#client.command({
				args: [
					'exec',
					...(input === undefined ? [] : ['--interactive']),
					name,
					'/usr/local/bin/node',
					'--input-type=module-typescript',
					'--eval',
					this.#helper,
					'--',
					operation,
					filename,
					String(transferLimit),
					requiresWrite ? 'write' : String(input?.byteLength ?? 0)
				],
				context,
				...(input !== undefined && { input }),
				operation,
				recovery: this.#resources.recovery,
				onOutput(output) {
					bytes += output.data.byteLength;

					if (bytes > transferLimit) {
						throw new RangeError(
							'The file response exceeded the transfer limit.'
						);
					}

					if (output.stream === 'stdout') {
						chunks.push(new Uint8Array(output.data));
					}
				}
			});

			switch (result.status) {
				case 0: {
					return new Uint8Array(Buffer.concat(chunks));
				}

				case 40: {
					throw new SandboxPathNotFoundError(identity);
				}

				case 41: {
					throw new SandboxPermissionDeniedError(identity);
				}

				case 42: {
					throw new SandboxOperationError(identity);
				}

				default: {
					throw new SandboxTransportError(identity);
				}
			}
		} catch (error) {
			if (!(
				error instanceof SandboxPathNotFoundError ||
				error instanceof SandboxPermissionDeniedError ||
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
		operation: FileOperation,
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
				new SandboxPermissionDeniedError({
					operation,
					providerId: 'example.docker',
					backendId: this.#resources.volume
				})
			);
		}

		clearTimeout(this.#idle);
		this.#pending++;

		const previous = this.#tail;
		const task = (async () => {
			await previous;

			try {
				return await this.#execute(
					operation,
					filename,
					context,
					input,
					requiresWrite
				);
			} finally {
				this.#pending--;

				if (
					this.#pending === 0 &&
					!this.#lifetime.aborted &&
					this.#name !== undefined
				) {
					this.#idle = setTimeout(() => {
						this.#tail = Promise.allSettled([this.#remove(context)]);
					}, 30_000).unref();
				}
			}
		})();

		this.#tail = Promise.allSettled([task]);

		return task;
	}

	readFile(filename: string, context: SandboxOperationContext) {
		return this.#request('readFile', filename, context);
	}

	async access(filename: string, context: SandboxOperationContext) {
		await this.#request('access', filename, context);
	}

	async writeFile(
		filename: string,
		content: Uint8Array,
		context: SandboxOperationContext
	) {
		if (content.byteLength > transferLimit) {
			throw new SandboxOperationError(
				{ operation: 'writeFile', recovery: this.#resources.recovery },
				{ cause: new RangeError('The file exceeds 16 MiB.') }
			);
		}

		await this.#request(
			'writeFile',
			filename,
			context,
			new Uint8Array(content)
		);
	}

	async writeAccess(filename: string, context: SandboxOperationContext) {
		await this.#request('access', filename, context, undefined, true);
	}

	async mkdir(filename: string, context: SandboxOperationContext) {
		await this.#request('mkdir', filename, context);
	}

	async listDirectory(filename: string, context: SandboxOperationContext) {
		const data = await this.#request('listDirectory', filename, context);
		const entries: unknown = JSON.parse(new TextDecoder().decode(data));

		if (!listValidator.Check(entries)) {
			throw new SandboxTransportError({
				operation: 'listDirectory',
				recovery: this.#resources.recovery
			});
		}

		return entries;
	}

	async stat(filename: string, context: SandboxOperationContext) {
		const data = await this.#request('stat', filename, context);
		const meta: unknown = JSON.parse(new TextDecoder().decode(data));

		if (!statValidator.Check(meta)) {
			throw new SandboxTransportError({
				operation: 'stat',
				recovery: this.#resources.recovery
			});
		}

		return meta;
	}

	async close() {
		clearTimeout(this.#idle);
		await this.#tail;
	}
}
