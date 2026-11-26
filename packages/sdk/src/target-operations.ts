import { readFile } from 'node:fs/promises';

import type {
	BackendFiles,
	BackendSearch,
	DirectoryEntry,
	FindRequest,
	FindResult,
	GrepRequest,
	GrepResult,
	SandboxErrorContext,
	SandboxOperationContext,
	SandboxWorkspace
} from './contracts.js';
import {
	SandboxOperationError,
	SandboxTransportError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import {
	isDirectoryEntries,
	isFileStat,
	isFindResult,
	isGrepResult
} from './file-result.js';
import { mapSandboxErrno } from './host-error.js';

export const sandboxTargetTransferLimit = 16 * 1024 * 1024;

export type TargetFileOperation =
	| 'access'
	| 'find'
	| 'grep'
	| 'listDirectory'
	| 'mkdir'
	| 'readFile'
	| 'stat'
	| 'writeFile';

export type TargetFileTransport = (
	operation: TargetFileOperation,
	filename: string,
	context: SandboxOperationContext,
	input?: Uint8Array,
	requiresWrite?: boolean
) => Promise<Uint8Array>;

export interface TargetFileOperations {
	readonly files: Required<BackendFiles>;
	readonly search: Required<BackendSearch>;
}

/**
Loads the Node program for access, stat, directory and byte operations in a target.
*/
export function targetFileHelper(): Promise<string> {
	const filename = import.meta.url.endsWith('.ts')
		? 'target-file.ts'
		: 'target-file.js';

	return readFile(new URL(filename, import.meta.url), 'utf8');
}

/**
Loads the portable Node search program for a descriptor-anchored Linux target.
*/
export async function targetSearchHelper(): Promise<string> {
	const filename = import.meta.url.endsWith('.ts')
		? 'target-search.ts'
		: 'target-search.js';

	const ignore = new URL(import.meta.resolve('ignore'));
	const [helper, ignoreSource, license] = await Promise.all([
		readFile(new URL(filename, import.meta.url), 'utf8'),
		readFile(ignore, 'utf8'),
		readFile(new URL('LICENSE-MIT', ignore), 'utf8')
	]);

	return `/*\n${license}\n*/\nconst createIgnore = (() => {
const module = { exports: {} };
${ignoreSource}
return module.exports;
})();\n${helper}`;
}

/**
Interprets the exit status from a provider kit file or search helper.
*/
export function checkSandboxTargetStatus(
	status: number | null,
	context: SandboxErrorContext
): void {
	switch (status) {
		case 0: {
			return;
		}

		case 40: {
			throw mapSandboxErrno('ENOENT', context);
		}

		case 41: {
			throw mapSandboxErrno('EACCES', context);
		}

		case 42: {
			throw new SandboxOperationError(context);
		}

		case 43: {
			throw new UnsupportedSandboxCapabilityError(context);
		}

		default: {
			throw new SandboxTransportError(context);
		}
	}
}

function searchOptions(request: FindRequest | GrepRequest): string {
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

/**
Adapts a provider's bounded byte transport to backend file and search methods.
The transport starts the helper inside the target and checks its exit status.
*/
export function createTargetFileOperations(
	run: TargetFileTransport,
	identity: Omit<SandboxErrorContext, 'operation'>,
	pathFlavor: SandboxWorkspace['pathFlavor'] = 'posix'
): TargetFileOperations {
	async function decode<Value>(
		operation: 'listDirectory' | 'stat' | 'find' | 'grep',
		filename: string,
		context: SandboxOperationContext,
		isValid: (value: unknown) => value is Value
	): Promise<Value> {
		const bytes = await run(operation, filename, context);

		try {
			const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
			const value: unknown = JSON.parse(text);

			if (isValid(value)) {
				return value;
			}

			throw new TypeError('Invalid target helper response.');
		} catch (error) {
			throw new SandboxTransportError(
				{ ...identity, operation },
				{ cause: error }
			);
		}
	}

	const stat = (filename: string, context: SandboxOperationContext) =>
		decode('stat', filename, context, isFileStat);

	return {
		files: {
			read: {
				readFile: (filename, context) => run('readFile', filename, context),
				async access(filename, context) {
					await run('access', filename, context);
				},
				stat
			},
			write: {
				async access(filename, context) {
					await run('access', filename, context, undefined, true);
				},
				async mkdir(filename, context) {
					await run('mkdir', filename, context);
				},
				async writeFile(filename, bytes, context) {
					if (bytes.byteLength > sandboxTargetTransferLimit) {
						throw new SandboxOperationError(
							{ ...identity, operation: 'writeFile' },
							{
								cause: new RangeError('The file exceeds 16 MiB.')
							}
						);
					}

					await run('writeFile', filename, context, new Uint8Array(bytes));
				}
			},
			list: {
				stat,
				listDirectory: (filename, context) =>
					decode(
						'listDirectory',
						filename,
						context,
						(value): value is readonly DirectoryEntry[] =>
							isDirectoryEntries(value, pathFlavor)
					)
			}
		},
		search: {
			find: (request, context) =>
				decode(
					'find',
					searchOptions(request),
					context,
					(value): value is FindResult =>
						isFindResult(value, pathFlavor, request.limit ?? 1000)
				),
			grep: (request, context) =>
				decode(
					'grep',
					searchOptions(request),
					context,
					(value): value is GrepResult =>
						isGrepResult(
							value,
							pathFlavor,
							request.limit ?? 100,
							request.context ?? 0
						)
				)
		}
	};
}
