import path from 'node:path';

import type {
	BackendDirectoryReader,
	BackendFileReader,
	BackendFileWriter,
	DirectoryEntry,
	FileStat,
	FindRequest,
	FindResult,
	GrepRequest,
	GrepResult,
	RecoveryDescriptor,
	Sandbox,
	SandboxFiles,
	SandboxOperation,
	SandboxOperationOptions,
	SandboxSearch,
	SandboxWriteOptions,
	TextUpdate
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	SandboxOperationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import type { BackendOwner } from './execution.js';
import { executeProcess } from './execution.js';
import {
	accessMode,
	findRequest,
	grepRequest,
	operationOptions,
	requirePath,
	writeOptions
} from './file-input.js';
import {
	isDirectoryEntries,
	isFileStat,
	isFindResult,
	isGrepResult
} from './file-result.js';
import type { MutationQueue } from './mutation-queue.js';
import { runOperation } from './operation-runner.js';
import { isRecord, snapshotCapabilities } from './validation.js';

export interface SandboxOwner extends BackendOwner {
	readonly identity: {
		readonly providerId: string;
		readonly backendId: string;
		readonly recovery?: RecoveryDescriptor;
	};
	readonly generationId: string;
	readonly mutations: MutationQueue;
}

class Files implements SandboxFiles {
	readonly #owner: SandboxOwner;

	constructor(owner: SandboxOwner) {
		this.#owner = owner;
	}

	#unsupported(operation: SandboxOperation): never {
		throw new UnsupportedSandboxCapabilityError({
			...this.#owner.identity,
			operation
		});
	}

	#read(operation: SandboxOperation): BackendFileReader {
		this.#owner.assertLive(operation);

		const group = this.#owner.backend.files?.read;

		return group === undefined ||
			!this.#owner.backend.capabilities.operations.includes('files.read')
			? this.#unsupported(operation)
			: group;
	}

	#write(operation: SandboxOperation): BackendFileWriter {
		this.#owner.assertLive(operation);

		const group = this.#owner.backend.files?.write;

		return group === undefined ||
			!this.#owner.backend.capabilities.operations.includes('files.write')
			? this.#unsupported(operation)
			: group;
	}

	#list(operation: SandboxOperation): BackendDirectoryReader {
		this.#owner.assertLive(operation);

		const group = this.#owner.backend.files?.list;

		return group === undefined ||
			!this.#owner.backend.capabilities.operations.includes('files.list')
			? this.#unsupported(operation)
			: group;
	}

	#invalid(operation: SandboxOperation): never {
		throw new InvalidSandboxDeclarationError({
			...this.#owner.identity,
			operation
		});
	}

	async readFile(
		filename: string,
		input?: SandboxOperationOptions
	): Promise<Uint8Array> {
		const group = this.#read('readFile');
		const target = requirePath(filename, 'readFile');
		const options = operationOptions(input, 'readFile');

		return runOperation(this.#owner, 'readFile', options, async (context) => {
			const bytes: unknown = await group.readFile(target, context);

			return bytes instanceof Uint8Array
				? new Uint8Array(bytes)
				: this.#invalid('readFile');
		});
	}

	async writeFile(
		filename: string,
		content: Uint8Array,
		input?: SandboxWriteOptions
	): Promise<void> {
		this.#owner.assertLive('writeFile');

		if (!(content instanceof Uint8Array)) {
			throw new InvalidSandboxRequestError({ operation: 'writeFile' });
		}

		const group = this.#write('writeFile');
		const target = requirePath(filename, 'writeFile');
		const options = writeOptions(input);
		const bytes = new Uint8Array(content);

		return runOperation(
			this.#owner,
			'writeFile',
			options,
			async (context) => {
				if (options.createParents === true) {
					await group.mkdir(
						path[this.#owner.backend.workspace.pathFlavor].dirname(target),
						context
					);
				}

				if (context.signal.aborted) {
					return;
				}

				await group.writeFile(target, bytes, context);
			},
			this.#owner.mutations
		);
	}

	async mkdir(
		filename: string,
		input?: SandboxOperationOptions
	): Promise<void> {
		const group = this.#write('mkdir');
		const target = requirePath(filename, 'mkdir');
		const options = operationOptions(input, 'mkdir');

		return runOperation(
			this.#owner,
			'mkdir',
			options,
			(context) => group.mkdir(target, context),
			this.#owner.mutations
		);
	}

	async access(
		filename: string,
		mode: 'read' | 'write',
		input?: SandboxOperationOptions
	): Promise<void> {
		const checked = accessMode(mode);
		const group =
			checked === 'read' ? this.#read('access') : this.#write('access');
		const target = requirePath(filename, 'access');
		const options = operationOptions(input, 'access');

		return runOperation(this.#owner, 'access', options, (context) =>
			group.access(target, context)
		);
	}

	async stat(
		filename: string,
		input?: SandboxOperationOptions
	): Promise<FileStat> {
		const group = this.#owner.backend.capabilities.operations.includes(
			'files.read'
		)
			? this.#read('stat')
			: this.#list('stat');
		const target = requirePath(filename, 'stat');
		const options = operationOptions(input, 'stat');

		return runOperation(this.#owner, 'stat', options, async (context) => {
			const stat: unknown = await group.stat(target, context);

			return isFileStat(stat)
				? Object.freeze({ kind: stat.kind, size: stat.size })
				: this.#invalid('stat');
		});
	}

	async listDirectory(
		filename: string,
		input?: SandboxOperationOptions
	): Promise<readonly DirectoryEntry[]> {
		const group = this.#list('listDirectory');
		const target = requirePath(filename, 'listDirectory');
		const options = operationOptions(input, 'listDirectory');

		return runOperation(
			this.#owner,
			'listDirectory',
			options,
			async (context) => {
				const entries: unknown = await group.listDirectory(target, context);

				return isDirectoryEntries(
					entries,
					this.#owner.backend.workspace.pathFlavor
				)
					? Object.freeze(
							entries.map((entry) =>
								Object.freeze({ name: entry.name, kind: entry.kind })
							)
						)
					: this.#invalid('listDirectory');
			}
		);
	}

	async updateText(
		filename: string,
		transform: (text: string) => string,
		input?: SandboxOperationOptions
	): Promise<TextUpdate> {
		this.#owner.assertLive('updateText');

		if (typeof transform !== 'function') {
			throw new InvalidSandboxRequestError({ operation: 'updateText' });
		}

		const read = this.#read('updateText');
		const write = this.#write('updateText');
		const target = requirePath(filename, 'updateText');
		const options = operationOptions(input, 'updateText');

		return runOperation(
			this.#owner,
			'updateText',
			options,
			async (context, check) => {
				await write.access(target, context);

				const bytes: unknown = await read.readFile(target, context);

				if (!(bytes instanceof Uint8Array)) {
					return this.#invalid('updateText');
				}

				let before: string;
				let after: unknown;

				try {
					before = new TextDecoder('utf-8', {
						fatal: true,
						ignoreBOM: true
					}).decode(bytes);
					after = transform(before);
				} catch (error) {
					throw new SandboxOperationError(
						{ ...this.#owner.identity, operation: 'updateText' },
						{ cause: error }
					);
				}

				if (typeof after !== 'string') {
					if (isRecord(after) && typeof after.then === 'function') {
						void Promise.allSettled([Promise.resolve(after)]);
					}

					throw new InvalidSandboxRequestError({ operation: 'updateText' });
				}

				check();
				await write.writeFile(target, new TextEncoder().encode(after), context);

				return Object.freeze({ before, after });
			},
			this.#owner.mutations
		);
	}
}

class Search implements SandboxSearch {
	readonly #owner: SandboxOwner;

	constructor(owner: SandboxOwner) {
		this.#owner = owner;
	}

	async find(
		input: FindRequest,
		settings?: SandboxOperationOptions
	): Promise<FindResult> {
		this.#owner.assertLive('find');

		const backend = this.#owner.backend;
		const group = backend.search;

		if (
			!backend.capabilities.operations.includes('search.find') ||
			group?.find === undefined
		) {
			throw new UnsupportedSandboxCapabilityError({
				...this.#owner.identity,
				operation: 'find'
			});
		}

		const request = findRequest(input);
		const options = operationOptions(settings, 'find');
		const find = group.find.bind(group);

		return runOperation(this.#owner, 'find', options, async (context) => {
			const result: unknown = await find(request, context);

			if (
				!isFindResult(
					result,
					backend.workspace.pathFlavor,
					request.limit ?? 1000
				)
			) {
				throw new InvalidSandboxDeclarationError({
					...this.#owner.identity,
					operation: 'find'
				});
			}

			return Object.freeze({
				paths: Object.freeze([...result.paths]),
				truncated: result.truncated
			});
		});
	}

	async grep(
		input: GrepRequest,
		settings?: SandboxOperationOptions
	): Promise<GrepResult> {
		this.#owner.assertLive('grep');

		const backend = this.#owner.backend;
		const group = backend.search;

		if (
			!backend.capabilities.operations.includes('search.grep') ||
			group?.grep === undefined
		) {
			throw new UnsupportedSandboxCapabilityError({
				...this.#owner.identity,
				operation: 'grep'
			});
		}

		const request = grepRequest(input);
		const options = operationOptions(settings, 'grep');
		const grep = group.grep.bind(group);

		return runOperation(this.#owner, 'grep', options, async (context) => {
			const result: unknown = await grep(request, context);

			if (
				!isGrepResult(
					result,
					backend.workspace.pathFlavor,
					request.limit ?? 100,
					request.context ?? 0
				)
			) {
				throw new InvalidSandboxDeclarationError({
					...this.#owner.identity,
					operation: 'grep'
				});
			}

			return Object.freeze({
				matches: Object.freeze(
					result.matches.map((match) =>
						Object.freeze({
							path: match.path,
							line: match.line,
							text: match.text,
							before: Object.freeze([...match.before]),
							after: Object.freeze([...match.after])
						})
					)
				),
				truncated: result.truncated
			});
		});
	}
}

export function createSandbox(owner: SandboxOwner): Sandbox {
	const backend = owner.backend;

	return Object.freeze({
		providerId: owner.identity.providerId,
		backendId: owner.identity.backendId,
		generationId: owner.generationId,
		workspace: Object.freeze({ ...backend.workspace }),
		capabilities: snapshotCapabilities(backend.capabilities),
		policy: Object.freeze({ ...backend.policy }),
		policyDescription: backend.policyDescription,
		exec: (request, options) => executeProcess(owner, request, options),
		files: Object.freeze(new Files(owner)),
		search: Object.freeze(new Search(owner))
	} satisfies Sandbox);
}
