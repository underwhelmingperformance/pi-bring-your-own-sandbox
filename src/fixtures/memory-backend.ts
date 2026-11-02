import path from 'node:path';

import type {
	BackendFiles,
	BackendProcessContext,
	DirectoryEntry,
	ProcessRequest,
	SandboxBackend,
	SandboxCapabilities,
	SandboxOperationContext,
	SandboxPolicy,
	SandboxWorkspace
} from '../contracts.js';
import { SandboxCancelledError, SandboxPathNotFoundError } from '../errors.js';

export class MemoryBackend implements SandboxBackend {
	readonly #contents = new Map<string, Uint8Array>();
	readonly #directories = new Set(['/remote/project']);
	readonly id = 'memory';
	readonly workspace: SandboxWorkspace = {
		root: '/remote/project',
		pathFlavor: 'posix',
		relationship: 'remote',
		description: 'In-memory test fixture; no OS isolation.'
	};
	readonly policy: SandboxPolicy = {
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	};
	readonly policyDescription = 'In-memory test fixture; no OS isolation.';
	readonly recovery = { kind: 'none' } as const;
	readonly capabilities: SandboxCapabilities;
	declare readonly files?: BackendFiles;
	beforeWrite:
		| ((
				path: string,
				content: Uint8Array,
				context: SandboxOperationContext
		  ) => Promise<void>)
		| undefined;
	beforeMkdir:
		| ((path: string, context: SandboxOperationContext) => Promise<void>)
		| undefined;
	readonly calls: { readonly operation: string; readonly path: string }[] = [];

	constructor(mode: 'files' | 'exec' = 'files') {
		this.capabilities = {
			processKinds: ['argv'],
			exitStatus: 'guaranteed',
			operations:
				mode === 'files'
					? ['exec', 'files.read', 'files.write', 'files.list']
					: ['exec'],
			shells: []
		};

		if (mode === 'exec') {
			return;
		}

		this.files = {
			read: {
				readFile: (filename, context) => {
					this.#check(context);

					const target = this.#resolve(filename);

					this.calls.push({ operation: 'readFile', path: target });

					const bytes = this.#contents.get(target);

					if (bytes === undefined) {
						throw new SandboxPathNotFoundError({ operation: 'readFile' });
					}

					return Promise.resolve(new Uint8Array(bytes));
				},
				access: (filename, context) => this.#access(filename, context),
				stat: (filename, context) => this.#stat(filename, context)
			},
			write: {
				writeFile: async (filename, content, context) => {
					const target = this.#resolve(filename);

					this.#check(context);
					this.calls.push({ operation: 'writeFile', path: target });
					await this.beforeWrite?.(target, content, context);
					this.#check(context);
					this.#contents.set(target, new Uint8Array(content));
				},
				access: (filename, context) => this.#access(filename, context),
				mkdir: async (filename, context) => {
					this.#check(context);
					await this.beforeMkdir?.(this.#resolve(filename), context);
					this.#check(context);

					let target = this.#resolve(filename);

					while (target !== path.posix.dirname(target)) {
						this.#directories.add(target);
						target = path.posix.dirname(target);
					}
				}
			},
			list: {
				stat: (filename, context) => this.#stat(filename, context),
				listDirectory: (filename, context) => {
					this.#check(context);

					const target = this.#resolve(filename);

					if (!this.#directories.has(target)) {
						throw new SandboxPathNotFoundError({ operation: 'listDirectory' });
					}

					const entries: DirectoryEntry[] = [];

					for (const file of this.#contents.keys()) {
						if (path.posix.dirname(file) === target) {
							entries.push({ name: path.posix.basename(file), kind: 'file' });
						}
					}

					for (const directory of this.#directories) {
						if (path.posix.dirname(directory) === target) {
							entries.push({
								name: path.posix.basename(directory),
								kind: 'directory'
							});
						}
					}

					return Promise.resolve(entries);
				}
			}
		};
	}

	#resolve(filename: string): string {
		return path.posix.resolve(this.workspace.root, filename);
	}

	#check(context: SandboxOperationContext): void {
		if (context.signal.aborted) {
			throw new SandboxCancelledError({
				operation: 'writeFile',
				reason: 'caller',
				completion: 'confirmed'
			});
		}
	}

	#access(filename: string, context: SandboxOperationContext): Promise<void> {
		this.#check(context);

		const target = this.#resolve(filename);

		if (!this.#contents.has(target) && !this.#directories.has(target)) {
			throw new SandboxPathNotFoundError({ operation: 'access' });
		}

		return Promise.resolve();
	}

	#stat(filename: string, context: SandboxOperationContext) {
		this.#check(context);

		const target = this.#resolve(filename);
		const bytes = this.#contents.get(target);

		if (bytes !== undefined) {
			return Promise.resolve({ kind: 'file' as const, size: bytes.byteLength });
		}

		if (this.#directories.has(target)) {
			return Promise.resolve({ kind: 'directory' as const, size: 0 });
		}

		throw new SandboxPathNotFoundError({ operation: 'stat' });
	}

	seed(filename: string, bytes: Uint8Array): void {
		this.#contents.set(this.#resolve(filename), new Uint8Array(bytes));
	}

	bytes(filename: string): Uint8Array | undefined {
		return this.#contents.get(this.#resolve(filename));
	}

	exec(
		_request: ProcessRequest,
		_context: BackendProcessContext
	): ReturnType<SandboxBackend['exec']> {
		return Promise.resolve({ kind: 'exited', exit: { kind: 'code', code: 0 } });
	}

	dispose(_context: SandboxOperationContext): Promise<void> {
		return Promise.resolve();
	}
}
