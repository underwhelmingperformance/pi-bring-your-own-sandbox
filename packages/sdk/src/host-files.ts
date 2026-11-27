import type { Dirent, Stats } from 'node:fs';
import { constants } from 'node:fs';
import {
	access,
	mkdir,
	open,
	readdir,
	readFile,
	stat,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';

import type { BackendFiles, FileKind, FileStat } from './contracts.js';
import { SandboxOperationError } from './errors.js';
import type { HostOperations } from './host-operations.js';

function kind(entry: Dirent | Stats): FileKind {
	if (entry.isSymbolicLink()) {
		return 'symlink';
	}

	if (entry.isDirectory()) {
		return 'directory';
	}

	return entry.isFile() ? 'file' : 'other';
}

async function boundedRead(
	filename: string,
	maxBytes: number,
	signal: AbortSignal
): Promise<Uint8Array> {
	await using file = await open(
		filename,
		constants.O_RDONLY | constants.O_NONBLOCK
	);

	const metadata = await file.stat();

	if (!metadata.isFile()) {
		throw new SandboxOperationError({ operation: 'readFile' });
	}

	const chunks: Uint8Array[] = [];
	const buffer = Buffer.alloc(64 * 1024);
	let size = 0;

	for (;;) {
		signal.throwIfAborted();

		const length = Math.min(buffer.length, maxBytes - size + 1);
		const { bytesRead } = await file.read(buffer, 0, length);

		if (bytesRead === 0) {
			return new Uint8Array(Buffer.concat(chunks, size));
		}

		size += bytesRead;

		if (size > maxBytes) {
			throw new SandboxOperationError({
				operation: 'readFile',
				detail: { kind: 'read-limit', maxBytes }
			});
		}

		chunks.push(new Uint8Array(buffer.subarray(0, bytesRead)));
	}
}

export function hostFiles(
	workspace: string,
	operations: HostOperations
): BackendFiles {
	const resolve = (filename: string) => path.resolve(workspace, filename);

	const fileStat = async (filename: string): Promise<FileStat> => {
		const entry = await stat(resolve(filename));

		return {
			kind: entry.isDirectory()
				? 'directory'
				: entry.isFile()
					? 'file'
					: 'other',
			size: entry.size
		};
	};

	return {
		read: {
			readFile: (filename, context, maxBytes) =>
				operations.run('readFile', context, async ({ signal }) =>
					maxBytes === undefined
						? new Uint8Array(await readFile(resolve(filename), { signal }))
						: boundedRead(resolve(filename), maxBytes, signal)
				),
			access: (filename, context) =>
				operations.run('access', context, () =>
					access(resolve(filename), constants.R_OK)
				),
			stat: (filename, context) =>
				operations.run('stat', context, () => fileStat(filename))
		},
		write: {
			writeFile: (filename, content, context) =>
				operations.run('writeFile', context, (running) =>
					writeFile(resolve(filename), content, { signal: running.signal })
				),
			access: (filename, context) =>
				operations.run('access', context, () =>
					access(resolve(filename), constants.W_OK)
				),
			mkdir: (filename, context) =>
				operations.run('mkdir', context, async () => {
					await mkdir(resolve(filename), { recursive: true });
				})
		},
		list: {
			stat: (filename, context) =>
				operations.run('stat', context, () => fileStat(filename)),
			listDirectory: (filename, context) =>
				operations.run('listDirectory', context, async () => {
					const entries = await readdir(resolve(filename), {
						withFileTypes: true
					});

					return entries
						.map((entry) => ({ name: entry.name, kind: kind(entry) }))
						.toSorted((left, right) =>
							Buffer.compare(Buffer.from(left.name), Buffer.from(right.name))
						);
				})
		}
	};
}
