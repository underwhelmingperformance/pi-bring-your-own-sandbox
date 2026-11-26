import { constants } from 'node:fs';
import { access, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

/**
Finds an executable file in the absolute `PATH` entries of this process and
returns its real path. Executables inside `root` are skipped, because a checkout can add
its own directories to `PATH`.
*/
export async function findHostExecutable(
	name: string,
	root: string
): Promise<string | undefined> {
	const directories = (process.env['PATH'] ?? '').split(path.delimiter);

	for (const directory of directories) {
		if (!path.isAbsolute(directory)) {
			continue;
		}

		try {
			const executable = await realpath(path.join(directory, name));
			const relative = path.relative(root, executable);

			if (!relative.startsWith('../')) {
				continue;
			}

			const entry = await stat(executable);

			if (!entry.isFile()) {
				continue;
			}

			await access(executable, constants.X_OK);

			return executable;
		} catch (error) {
			if (!(
				error instanceof Error &&
				'code' in error &&
				['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code))
			)) {
				throw error;
			}
		}
	}

	return;
}
