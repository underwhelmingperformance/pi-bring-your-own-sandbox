import type { Dirent, Stats } from 'node:fs';
import { constants } from 'node:fs';
import {
	access,
	mkdir,
	readdir,
	readFile,
	stat,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';

import type { BackendFiles, FileKind, FileStat } from './contracts.js';
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
			readFile: (filename, context) =>
				operations.run(
					'readFile',
					context,
					async (running) =>
						new Uint8Array(
							await readFile(resolve(filename), { signal: running.signal })
						)
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
