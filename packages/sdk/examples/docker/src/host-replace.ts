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
import { createInterface } from 'node:readline';

const staging = process.argv[1];

if (!staging || process.platform !== 'darwin' || !path.isAbsolute(staging)) {
	throw new Error(
		'The macOS workspace service requires a private staging directory.'
	);
}

const workspace = process.cwd();

function isWorkspacePath(value: unknown): value is string {
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

async function hasWorkspaceParent(filename: string): Promise<boolean> {
	const parent = path.resolve(workspace, path.dirname(filename));

	return (await realpath(parent)) === parent;
}

function isRegularOrDirectory(entry: Stats): boolean {
	return entry.isDirectory() || (entry.isFile() && entry.nlink === 1);
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

	if (!isWorkspacePath(target)) {
		return { status: 'EINVAL' };
	}

	try {
		if (!(await hasWorkspaceParent(target))) {
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

				const file = await open(target, 'wx', request.mode);

				await file.close();
				break;
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

			case 'rename': {
				if (!('source' in request) || !isWorkspacePath(request.source)) {
					return { status: 'EINVAL' };
				}

				if (
					!(await hasWorkspaceParent(request.source)) ||
					!isRegularOrDirectory(await lstat(request.source))
				) {
					return { status: 'EACCES' };
				}

				const destination = await existingEntry(target);

				if (destination && !isRegularOrDirectory(destination)) {
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

const requests = createInterface({ input: process.stdin });

for await (const line of requests) {
	const request: unknown = JSON.parse(line);
	const result = await change(staging, request);

	process.stdout.write(JSON.stringify(result) + '\n');
}
