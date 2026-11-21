import { execFile } from 'node:child_process';
import { lstat, readlink } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

const run = promisify(execFile);

async function resolvedPath(filename: string): Promise<string> {
	let remaining = filename.split('/').filter(Boolean);
	let resolved = '/';
	let links = 0;

	while (remaining.length > 0) {
		const component = remaining.shift();

		if (component === undefined) {
			break;
		}

		resolved = path.join(resolved, component);

		try {
			const entry = await lstat(resolved);

			if (entry.isSymbolicLink()) {
				if (++links > 40) {
					throw new Error(
						'Too many symbolic links in a protected workspace path.'
					);
				}

				const target = path.resolve(
					path.dirname(resolved),
					await readlink(resolved)
				);

				remaining = [...target.split('/').filter(Boolean), ...remaining];
				resolved = '/';
			}
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				error.code === 'ENOENT'
			) {
				return path.join(resolved, ...remaining);
			}

			throw error;
		}
	}

	return resolved;
}

async function gitPaths(
	workspace: string,
	signal?: AbortSignal
): Promise<string[]> {
	const arguments_ = [
		'--no-pager',
		'--no-optional-locks',
		'-C',
		workspace,
		'rev-parse',
		'--path-format=absolute',
		'--absolute-git-dir',
		'--git-common-dir',
		'--git-path',
		'hooks',
		'--git-path',
		'objects',
		'--git-path',
		'index'
	];

	try {
		const { stdout } = await run('/usr/bin/git', arguments_, {
			cwd: '/',
			env: {
				PATH: '/usr/bin:/bin',
				HOME: process.env['HOME'],
				XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
				LC_ALL: 'C',
				GIT_TERMINAL_PROMPT: '0'
			},
			signal,
			timeout: 5000,
			maxBuffer: 65_536,
			encoding: 'buffer'
		});
		const paths = new TextDecoder('utf-8', { fatal: true })
			.decode(stdout)
			.split('\n');

		if (
			paths.pop() !== '' ||
			paths.length !== 5 ||
			paths.some((filename) => !path.isAbsolute(filename))
		) {
			throw new Error('Git returned invalid workspace metadata paths.');
		}

		return paths;
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			error.code === 128 &&
			'stderr' in error &&
			Buffer.isBuffer(error.stderr) &&
			error.stderr
				.toString('utf8')
				.startsWith(
					'fatal: not a git repository (or any of the parent directories)'
				)
		) {
			return [];
		}

		throw error;
	}
}

export async function protectedWorkspacePaths(
	workspace: string,
	relativePaths: readonly string[],
	signal?: AbortSignal
) {
	const paths = new Set(relativePaths);
	const candidates = [
		...relativePaths.map((relative) => path.join(workspace, relative)),
		...(await gitPaths(workspace, signal))
	];

	for (const candidate of candidates) {
		signal?.throwIfAborted();

		for (const absolute of [candidate, await resolvedPath(candidate)]) {
			const relative = path.relative(workspace, absolute);

			if (
				relative === '' ||
				workspace.startsWith(absolute.endsWith('/') ? absolute : absolute + '/')
			) {
				throw new Error('A protected resource contains the entire workspace.');
			}

			if (relative !== '..' && !relative.startsWith('../')) {
				paths.add(relative);
			}
		}
	}

	return [...paths];
}
