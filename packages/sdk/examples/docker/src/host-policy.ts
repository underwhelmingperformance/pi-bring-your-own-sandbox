import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { HOST_CONFIGURATION_PROTECTION } from 'pi-bring-your-own-sandbox/api';

export async function hostPolicy(
	workspace: string,
	staging: string,
	runtime: string,
	additionalPaths: readonly string[]
) {
	const protectedPaths = [
		...new Set([
			...HOST_CONFIGURATION_PROTECTION.map((resource) =>
				resource.kind === 'git-metadata' ? '.git' : resource.path
			),
			...additionalPaths
		])
	];

	for (const relative of protectedPaths) {
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
			'-p',
			[profile, ...rules, ...libraryRules].join('\n')
		]
	};
}
