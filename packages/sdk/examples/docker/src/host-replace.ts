import { type BigIntStats, constants, type Stats } from 'node:fs';
import {
	access,
	lstat,
	mkdir,
	open,
	realpath,
	rename,
	rmdir,
	unlink
} from 'node:fs/promises';
import path from 'node:path';

const staging = process.argv[1];

if (!staging || process.platform !== 'darwin' || !path.isAbsolute(staging)) {
	throw new Error(
		'The macOS workspace service requires a private staging directory.'
	);
}

const workspace = process.cwd();
const resources: unknown = JSON.parse(process.argv[2] ?? 'null');

if (
	!Array.isArray(resources) ||
	!resources.every((value): value is string => typeof value === 'string')
) {
	throw new TypeError('Expected a list of protected workspace paths.');
}

const foldedPath = (relative: string) =>
	relative.normalize('NFD').toUpperCase();
const protectedPaths = resources.map((relative) => foldedPath(relative));

function isProtected(relative: string, isMkdir = false): boolean {
	const folded = foldedPath(relative);

	return (
		folded.split('/').includes('.GIT') ||
		protectedPaths.some(
			(resource) =>
				resource === folded ||
				(!isMkdir && resource.startsWith(folded + '/')) ||
				folded.startsWith(resource + '/')
		)
	);
}

async function hasWorkspaceParent(filename: string): Promise<boolean> {
	const parent = path.resolve(workspace, path.dirname(filename));

	return (await realpath(parent)) === parent;
}

function isRegularOrDirectory(
	entry: Stats,
	isFileReplacement = false
): boolean {
	return (
		entry.isDirectory() ||
		(entry.isFile() && (isFileReplacement || entry.nlink === 1))
	);
}

async function existingEntry(filename: string) {
	try {
		return await lstat(filename);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw error;
	}
}

function identity(entry: BigIntStats) {
	return [entry.dev, entry.ino, entry.birthtimeNs].join('/');
}

async function change(
	stagingDirectory: string,
	request: unknown
): Promise<{ status: string; identity?: string }> {
	if (
		typeof request !== 'object' ||
		request === null ||
		!('op' in request) ||
		!('target' in request)
	) {
		return { status: 'EINVAL' };
	}

	const { op, target } = request;

	if (typeof target !== 'string') {
		return { status: 'EINVAL' };
	}

	try {
		if (
			isProtected(target, op === 'mkdir') ||
			!(await hasWorkspaceParent(target))
		) {
			return { status: 'EACCES' };
		}

		switch (op) {
			case 'create':
			case 'mkdir': {
				if (
					!('mode' in request) ||
					typeof request.mode !== 'number' ||
					!Number.isSafeInteger(request.mode) ||
					request.mode < 0 ||
					request.mode > 0o777
				) {
					return { status: 'EINVAL' };
				}

				if (op === 'mkdir') {
					await mkdir(target, { mode: request.mode });
					break;
				}

				await using file = await open(target, 'wx', request.mode);

				const created = await file.stat({ bigint: true });

				return { status: 'OK', identity: identity(created) };
			}

			case 'unlink': {
				const entry = await lstat(target);

				if (!entry.isFile() || entry.nlink !== 1) {
					return { status: 'EACCES' };
				}

				await unlink(target);
				break;
			}

			case 'rmdir': {
				await rmdir(target);
				break;
			}

			case 'rename':
			case 'rename-file': {
				if (!('source' in request) || typeof request.source !== 'string') {
					return { status: 'EINVAL' };
				}

				if (
					isProtected(request.source) ||
					!(await hasWorkspaceParent(request.source))
				) {
					return { status: 'EACCES' };
				}

				const source = await lstat(request.source);

				if (
					!isRegularOrDirectory(source) ||
					(op === 'rename-file' && !source.isFile())
				) {
					return { status: 'EACCES' };
				}

				const destination = await existingEntry(target);

				if (
					destination &&
					!isRegularOrDirectory(destination, op === 'rename-file')
				) {
					return { status: 'EACCES' };
				}

				await rename(request.source, target);
				break;
			}

			case 'identify':
			case 'replace': {
				const current = await lstat(target, { bigint: true });

				if (!current.isFile() || current.nlink !== 1n) {
					return { status: 'EACCES' };
				}

				if (
					!('size' in request) ||
					String(current.size) !== request.size ||
					!('mtime' in request) ||
					String(current.mtimeNs) !== request.mtime
				) {
					return { status: 'ESTALE' };
				}

				const expected = identity(current);

				if (op === 'identify') {
					return { status: 'OK', identity: expected };
				}

				if (!('expected' in request) || request.expected !== expected) {
					return { status: 'ESTALE' };
				}

				if (
					!('source' in request) ||
					typeof request.source !== 'string' ||
					!/^\.pi-byos-write-[0-9]+$/u.test(request.source)
				) {
					return { status: 'EINVAL' };
				}

				const source = path.join(stagingDirectory, request.source);
				const replacement = await lstat(source, { bigint: true });

				if (!replacement.isFile() || replacement.nlink !== 1n) {
					return { status: 'EACCES' };
				}

				await access(target, constants.W_OK);
				await rename(source, target);

				return { status: 'OK', identity: identity(replacement) };
			}

			default: {
				return { status: 'EINVAL' };
			}
		}

		return { status: 'OK' };
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			typeof error.code === 'string'
		) {
			return { status: error.code };
		}

		throw error;
	}
}

const request: unknown = JSON.parse(process.argv[3] ?? 'null');
const result = await change(staging, request);

process.stdout.write(JSON.stringify(result) + '\n');
