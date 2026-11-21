import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { HOST_CONFIGURATION_PROTECTION } from 'pi-bring-your-own-sandbox/api';

import { protectedWorkspacePaths } from './git-paths.js';

export function isWorkspacePath(value: unknown): value is string {
	return (
		typeof value === 'string' &&
		Buffer.byteLength(value) <= 4095 &&
		value
			.split('/')
			.every(
				(component) =>
					component.length > 0 &&
					component !== '.' &&
					component !== '..' &&
					!component.startsWith('.pi-byos-write-') &&
					!component.includes('\0') &&
					Buffer.byteLength(component) <= 255
			)
	);
}

export async function prepareHostPolicy(
	workspace: string,
	staging: string,
	runtime: string,
	additionalPaths: readonly string[]
) {
	const requested = [
		...new Set([
			...HOST_CONFIGURATION_PROTECTION.map((resource) =>
				resource.kind === 'git-metadata' ? '.git' : resource.path
			),
			...additionalPaths
		])
	];

	for (const relative of requested) {
		if (
			!/^[\u{20}-\u{7E}]+$/u.test(relative) ||
			relative
				.split('/')
				.some(
					(part) =>
						!part || part === '.' || part === '..' || part.includes('\0')
				)
		) {
			throw new TypeError(
				'The macOS mount requires printable ASCII in protected path components.'
			);
		}
	}

	const profile = await readFile(
		new URL('host-replace.sb', import.meta.url),
		'utf8'
	);

	function checkRuntimePath(file: string) {
		if (
			[workspace, staging].some((directory) => {
				const relative = path.relative(directory, file);

				return (
					relative !== '..' &&
					!relative.startsWith('../') &&
					!path.isAbsolute(relative)
				);
			})
		) {
			throw new Error(
				'The native workspace helper needs a Node installation outside its writable directories.'
			);
		}
	}

	checkRuntimePath(runtime);

	const report = await promisify(execFile)(
		runtime,
		['-p', 'JSON.stringify(process.report.getReport().sharedObjects)'],
		{ cwd: '/', env: {}, timeout: 5000 }
	);
	const objects: unknown = JSON.parse(report.stdout);

	if (
		!Array.isArray(objects) ||
		!objects.every(
			(value): value is string =>
				typeof value === 'string' && path.isAbsolute(value)
		)
	) {
		throw new TypeError('Node returned invalid shared library paths.');
	}

	const libraries = await Promise.all(
		objects
			.filter(
				(library) =>
					!library.startsWith('/usr/lib/') &&
					!library.startsWith('/System/Library/')
			)
			.map((library) => realpath(library))
	);

	for (const library of libraries) {
		checkRuntimePath(library);
	}

	const libraryRules = libraries.map((_, index) => {
		const parameter = '(param "LIBRARY_' + String(index) + '")';

		return (
			'(allow file-read-metadata (path-ancestors ' +
			parameter +
			'))\n(allow file-read* file-map-executable (literal ' +
			parameter +
			'))'
		);
	});

	return async (replaceEntry?: string, signal?: AbortSignal) => {
		if (replaceEntry !== undefined && !isWorkspacePath(replaceEntry)) {
			throw new TypeError(
				'Expected a workspace-relative replacement destination.'
			);
		}

		const protectedPaths = await protectedWorkspacePaths(
			workspace,
			requested,
			signal
		);

		if (
			protectedPaths.some((relative) => !/^[\u{20}-\u{7E}]+$/u.test(relative))
		) {
			throw new Error(
				'The resolved workspace protection requires a non-ASCII path.'
			);
		}

		const rules = protectedPaths.map((_, index) => {
			const parameter = '(param "RESOURCE_' + String(index) + '")';

			return (
				'(deny file-write* (subpath ' +
				parameter +
				'))\n' +
				'(deny file-write-unlink (path-ancestors ' +
				parameter +
				'))'
			);
		});

		return {
			protectedPaths,
			args: [
				'-D',
				'WORKSPACE=' + workspace,
				'-D',
				'RUNTIME=' + runtime,
				'-D',
				'STAGING=' + staging,
				...protectedPaths.flatMap((relative, index) => [
					'-D',
					'RESOURCE_' + String(index) + '=' + path.join(workspace, relative)
				]),
				...libraries.flatMap((library, index) => [
					'-D',
					'LIBRARY_' + String(index) + '=' + library
				]),
				...(replaceEntry === undefined
					? []
					: ['-D', 'DESTINATION=' + path.join(workspace, replaceEntry)]),
				'-p',
				[
					profile,
					...(replaceEntry === undefined
						? []
						: [
								'(allow file-write-unlink (require-all (literal (param "DESTINATION")) (subpath (param "WORKSPACE")) (vnode-type REGULAR-FILE)))',
								'(deny file-write-unlink (require-not (vnode-type REGULAR-FILE)))'
							]),
					...rules,
					...libraryRules
				].join('\n')
			]
		};
	};
}
