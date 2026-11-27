import { readFile } from 'node:fs/promises';
import { gzipSync } from 'node:zlib';

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
	requiresWrite?: boolean,
	maxBytes?: number
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
Loads the portable Node search program. Darwin support requires the provider
to run the program with the same confinement as its commands.
*/
export async function targetSearchHelper(
	options: { readonly sameConfinementAsCommands?: boolean } = {}
): Promise<string> {
	const filename = import.meta.url.endsWith('.ts')
		? 'target-search.ts'
		: 'target-search.js';

	const ignore = new URL(import.meta.resolve('ignore'));
	const [helper, ignoreSource, ignoreLicense, globMatcher] = await Promise.all([
		readFile(new URL(filename, import.meta.url), 'utf8'),
		readFile(ignore, 'utf8'),
		readFile(new URL('LICENSE-MIT', ignore), 'utf8'),
		embeddedGlobMatcher()
	]);

	const isSameConfinementAsCommands =
		options.sameConfinementAsCommands === true;
	const matcher = isSameConfinementAsCommands
		? await embeddedSearchMatcher()
		: 'const loadEmbeddedMatcher = undefined;';

	return `const hasCommandConfinement = ${String(isSameConfinementAsCommands)};
${matcher}
${globMatcher}
/*\n${ignoreLicense}\n*/\nconst createIgnore = (() => {
const module = { exports: {} };
${ignoreSource}
return module.exports;
})();\n${helper}`;
}

async function embeddedGlobMatcher(): Promise<string> {
	const entry = new URL(import.meta.resolve('picomatch'));
	const files = ['constants', 'utils', 'scan', 'parse', 'picomatch'];
	const sources = files.map(async (file) => {
		const text = await readFile(
			new URL('./lib/' + file + '.js', entry),
			'utf8'
		);

		return `['./${file}', (module, exports, require) => {\n${text}\n}]`;
	});
	const [license, factories] = await Promise.all([
		readFile(new URL('LICENSE', entry), 'utf8'),
		Promise.all(sources)
	]);
	const moduleSource = `
const modules = new Map();
function require(id) {
	if (!modules.has(id)) throw new Error('Unknown bundled glob module ' + id);
	return modules.get(id);
}
for (const [id, load] of [${factories.join(',\n')}]) {
	const module = { exports: {} };
	load(module, module.exports, require);
	modules.set(id, module.exports);
}
export default require('./picomatch');
`;
	const compressed = gzipSync(moduleSource).toString('base64');

	return `/*\n${license}\n*/
import { gunzipSync as unpackGlobMatcher } from 'node:zlib';
const loadPortableGlob = async () => {
	const module = await import('data:text/javascript;base64,' +
		unpackGlobMatcher(Buffer.from('${compressed}', 'base64')).toString('base64'));
	return module.default;
};`;
}

async function embeddedSearchMatcher(): Promise<string> {
	const matcher = new URL(import.meta.resolve('re2js'));
	const [source, license] = await Promise.all([
		readFile(matcher),
		readFile(new URL('../LICENSE', matcher), 'utf8')
	]);
	const compressed = gzipSync(source).toString('base64');

	return `/*\n${license}\n*/
import { gunzipSync as unpackMatcher } from 'node:zlib';
const loadEmbeddedMatcher = () => import('data:text/javascript;base64,' +
	unpackMatcher(Buffer.from('${compressed}', 'base64')).toString('base64'));`;
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

		case 44: {
			if (context.detail?.kind === 'read-limit') {
				throw new SandboxOperationError(context);
			}

			throw new SandboxTransportError(context);
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
				async readFile(filename, context, maxBytes) {
					const bytes = await run(
						'readFile',
						filename,
						context,
						undefined,
						undefined,
						maxBytes
					);

					if (maxBytes !== undefined && bytes.byteLength > maxBytes) {
						throw new SandboxOperationError({
							...identity,
							operation: 'readFile',
							detail: { kind: 'read-limit', maxBytes }
						});
					}

					return bytes;
				},
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
