import { randomUUID } from 'node:crypto';

import type {
	BackendFileReader,
	FindRequest,
	GrepRequest,
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
import {
	type DockerWorkspaceMount,
	workspaceCommand
} from './workspace-mount.js';

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

const findSchema = Type.Object({
	paths: Type.Array(Type.String()),
	truncated: Type.Boolean()
});
const findValidator = Compile(findSchema);
const matchSchema = Type.Object({
	path: Type.String(),
	line: Type.Integer({ minimum: 1 }),
	text: Type.String(),
	before: Type.Array(Type.String()),
	after: Type.Array(Type.String())
});
const grepValidator = Compile(
	Type.Object({ matches: Type.Array(matchSchema), truncated: Type.Boolean() })
);

export interface DockerFileHelpers {
	readonly files: string;
	readonly search: string;
	readonly matcher: Uint8Array;
}

type FileOperation =
	| 'find'
	| 'grep'
	| 'mkdir'
	| 'listDirectory'
	| 'writeFile'
	| 'readFile'
	| 'stat'
	| 'access';

/**
Serialises fixed filesystem operations in an unprivileged container. Removing
the container cancels an individual call without affecting shell workloads.
*/
export class DockerFileWorker implements BackendFileReader {
	readonly #resources: DockerResources;
	readonly #client: DockerClient;
	readonly #workspace: DockerWorkspaceMount;
	readonly #helpers: DockerFileHelpers;
	readonly #lifetime: AbortSignal;
	#name: string | undefined;
	#matcherWorker: string | undefined;
	#tail: Promise<unknown> = Promise.resolve();
	#pending = 0;
	#idle: NodeJS.Timeout | undefined;
	#requiresRemoval = false;

	constructor(
		resources: DockerResources,
		client: DockerClient,
		workspace: DockerWorkspaceMount,
		helpers: DockerFileHelpers,
		lifetime: AbortSignal
	) {
		this.#resources = resources;
		this.#client = client;
		this.#workspace = workspace;
		this.#helpers = helpers;
		this.#lifetime = lifetime;
	}

	#identity(operation: FileOperation) {
		return {
			operation,
			providerId: 'example.docker',
			backendId: this.#resources.volume,
			recovery: this.#resources.recovery
		};
	}

	async #start(
		context: SandboxOperationContext,
		operation: FileOperation
	): Promise<string> {
		if (this.#requiresRemoval) {
			await this.#remove(context, operation);
		}

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
				typeof this.#workspace.mount === 'string'
					? '--user=65534:65534'
					: '--user=0:0',
				typeof this.#workspace.mount === 'string'
					? '--workdir=/workspace'
					: '--workdir=/',
				'--tmpfs=/opt/pi-byos/node_modules/re2js:rw,noexec,nosuid,nodev,size=1m,mode=0755,uid=65533,gid=65533',
				'--pids-limit=32',
				'--memory=128m',
				'--cpus=1',
				'--log-driver=none',
				...workspaceCommand(
					this.#workspace,
					'worker',
					DOCKER_IMAGE,
					'/bin/sleep',
					['infinity']
				)
			],
			context,
			operation
		);
		context.signal.throwIfAborted();
		this.#lifetime.throwIfAborted();
		await this.#resources.checked(['start', name], context, operation);

		if (typeof this.#workspace.mount !== 'string') {
			await this.#resources.checked(
				['exec', '--user=65534:65534', name, '/mount-check', 'wait-worker'],
				context,
				operation
			);
		}

		return name;
	}

	#execAs(name: string, directory: string, uid: 65_533 | 65_534) {
		const user = String(uid);

		if (typeof this.#workspace.mount === 'string') {
			return ['--user=' + user + ':' + user, '--workdir=' + directory, name];
		}

		return [
			'--user=0:0',
			'--workdir=' + directory,
			name,
			'/usr/bin/setpriv',
			'--reuid=' + user,
			'--regid=' + user,
			'--clear-groups',
			'--no-new-privs',
			'--bounding-set=-all',
			'--inh-caps=-all',
			'--ambient-caps=-all',
			'--'
		];
	}

	async #installMatcher(name: string, context: SandboxOperationContext) {
		if (this.#matcherWorker === name) {
			return;
		}

		await this.#resources.checked(
			[
				'exec',
				'--interactive',
				...this.#execAs(name, '/opt/pi-byos/node_modules/re2js', 65_533),
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
		operation: FileOperation | 'dispose'
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
								reportDiagnostic: context.reportDiagnostic
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
		operation: FileOperation,
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
					...(input === undefined ? [] : ['--interactive']),
					...this.#execAs(
						name,
						isSearch ? '/opt/pi-byos' : '/workspace',
						65_534
					),
					'/usr/local/bin/node',
					'--input-type=module-typescript',
					'--eval',
					isSearch ? this.#helpers.search : this.#helpers.files,
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

					if (bytes > transferLimit) {
						limitFailure = new RangeError(
							'The file response exceeded the transfer limit.'
						);

						throw limitFailure;
					}

					chunks.push(new Uint8Array(output.data));
				}
			});

			signal.throwIfAborted();

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

	async #json<Value>(
		operation: 'listDirectory' | 'stat' | 'find' | 'grep',
		filename: string,
		context: SandboxOperationContext,
		isValid: (value: unknown) => value is Value
	): Promise<Value> {
		const data = await this.#request(operation, filename, context);

		try {
			const value: unknown = JSON.parse(
				new TextDecoder('utf-8', { fatal: true }).decode(data)
			);

			if (isValid(value)) {
				return value;
			}

			throw new TypeError('Invalid Docker helper response.');
		} catch (error) {
			throw new SandboxTransportError(
				{
					operation,
					providerId: 'example.docker',
					backendId: this.#resources.volume,
					recovery: this.#resources.recovery
				},
				{ cause: error }
			);
		}
	}

	#searchOptions(request: FindRequest | GrepRequest): string {
		const options = new URLSearchParams();

		for (const [key, value] of Object.entries(request)) {
			if (
				typeof value === 'string' ||
				typeof value === 'boolean' ||
				typeof value === 'number'
			) {
				options.set(key, String(value));
			}
		}

		return options.toString();
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
			throw new SandboxOperationError(this.#identity('writeFile'), {
				cause: new RangeError('The file exceeds 16 MiB.')
			});
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

	listDirectory(filename: string, context: SandboxOperationContext) {
		return this.#json('listDirectory', filename, context, (value) =>
			listValidator.Check(value)
		);
	}

	stat(filename: string, context: SandboxOperationContext) {
		return this.#json('stat', filename, context, (value) =>
			statValidator.Check(value)
		);
	}

	find(request: FindRequest, context: SandboxOperationContext) {
		const options = this.#searchOptions(request);

		return this.#json('find', options, context, (value) =>
			findValidator.Check(value)
		);
	}

	grep(request: GrepRequest, context: SandboxOperationContext) {
		const options = this.#searchOptions(request);

		return this.#json('grep', options, context, (value) =>
			grepValidator.Check(value)
		);
	}

	async close() {
		clearTimeout(this.#idle);
		await this.#tail;
	}
}
