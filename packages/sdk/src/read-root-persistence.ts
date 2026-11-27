import { constants } from 'node:fs';
import {
	mkdtemp,
	open,
	realpath,
	rename,
	rm,
	unlink,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';

import type { SandboxReadRootPersistence } from './contracts.js';
import { cleanDisplayText } from './display-text.js';
import { InvalidSandboxConfigError } from './errors.js';
import { isWithinHostRoots } from './host-paths.js';
import { observe } from './lifecycle.js';
import { resolveReadRoot } from './path-grants.js';
import type { ConfiguredProviderV1, ProviderServiceV1 } from './protocol.js';
import { sharedSettingsSchema } from './request-schemas.js';
import { checker } from './schemas.js';
import { isPolicy, isRecord } from './validation.js';

export type SaveReadRoots = (
	paths: readonly string[],
	checkout: string,
	signal: AbortSignal
) => Promise<string>;

const isReadRoots = checker(sharedSettingsSchema.properties.readRoots);

async function readSettings(file: string): Promise<Buffer | undefined> {
	try {
		const handle = await open(
			file,
			constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
		);

		try {
			const status = await handle.stat();

			if (!status.isFile()) {
				throw new Error('The provider settings path must be a regular file.');
			}

			return await handle.readFile();
		} finally {
			await handle.close();
		}
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw error;
	}
}

async function addRoots(
	settings: Record<string, unknown>,
	paths: readonly string[]
): Promise<string[]> {
	const policy = settings['policy'];
	const configured =
		settings['readRoots'] === undefined ? [] : settings['readRoots'];

	if (
		(policy !== undefined &&
			(!isPolicy(policy) || policy.hostUserData !== 'read-only')) ||
		!isReadRoots(configured)
	) {
		throw new Error(
			'Persistent reads require read-only host user data settings.'
		);
	}

	const resolved = await Promise.all(
		configured.map(async (root) => [await resolveReadRoot(root), root] as const)
	);
	const distinct = new Map<string, string>();

	for (const [canonical, spelling] of resolved) {
		if (!distinct.has(canonical)) {
			distinct.set(canonical, spelling);
		}
	}

	for (const approved of paths) {
		if (!distinct.has(approved)) {
			distinct.set(approved, approved);
		}
	}

	return distinct.values().toArray();
}

class ReadRootPersistenceConflict extends Error {}

async function acquireGuard(filename: string) {
	try {
		return await open(filename, 'wx', 0o600);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
			throw new ReadRootPersistenceConflict(
				'The read approval conflicts with an existing settings guard at ' +
					filename +
					'.'
			);
		}

		throw error;
	}
}

async function commitSettings(
	file: string,
	original: Buffer | undefined,
	temporary: string | undefined,
	assertActive: () => void
): Promise<void> {
	assertActive();

	const guardFile = file + '.byos-read-roots.lock';
	const guard = await acquireGuard(guardFile);

	try {
		const current = await readSettings(file);
		const isUnchanged =
			current === undefined
				? original === undefined
				: original !== undefined && current.equals(original);

		if (!isUnchanged) {
			throw new ReadRootPersistenceConflict(
				'The provider settings changed before the read approval could be saved. Retry the approval.'
			);
		}

		assertActive();

		if (temporary !== undefined) {
			await rename(temporary, file);
		}
	} finally {
		try {
			await guard.close();
		} finally {
			await unlink(guardFile);
		}
	}
}

async function saveSettings(
	file: string,
	original: Buffer | undefined,
	contents: string | undefined,
	assertActive: () => void
): Promise<void> {
	if (contents === undefined) {
		return commitSettings(file, original, undefined, assertActive);
	}

	const scratch = await mkdtemp(
		path.join(path.dirname(file), '.byos-read-roots-')
	);
	const temporary = path.join(scratch, 'settings');

	try {
		await writeFile(temporary, contents, { flag: 'wx', mode: 0o600 });
		await commitSettings(file, original, temporary, assertActive);
	} finally {
		await rm(scratch, { recursive: true, force: true });
	}
}

async function updateSettings(
	file: string,
	paths: readonly string[],
	validate: Parameters<SandboxReadRootPersistence['updateSettings']>[1],
	assertActive: () => void
): Promise<string> {
	assertActive();

	const original = await readSettings(file);
	const settings: unknown =
		original === undefined ? {} : JSON.parse(original.toString('utf8'));

	if (!isRecord(settings) || !validate(settings)) {
		throw new Error('The provider settings file failed validation.');
	}

	const readRoots = await addRoots(settings, paths);
	const updated = { ...settings, readRoots };

	if (!validate(updated)) {
		throw new Error('The new provider settings failed validation.');
	}

	const contents =
		JSON.stringify(settings['readRoots']) === JSON.stringify(readRoots)
			? undefined
			: JSON.stringify(updated, undefined, 2) + '\n';

	await saveSettings(file, original, contents, assertActive);

	assertActive();

	return file;
}

export function bindReadRootPersistence(
	provider: ProviderServiceV1,
	persist: NonNullable<ConfiguredProviderV1['persistReadRoot']>,
	agentDirectory: string
): SaveReadRoots {
	return async (paths, checkout, signal) => {
		try {
			const directory = await realpath(agentDirectory);

			if (
				isWithinHostRoots(agentDirectory, [checkout]) ||
				isWithinHostRoots(directory, [checkout])
			) {
				throw new Error(
					'The global agent directory must be outside the checkout.'
				);
			}

			let isActive = true;
			let pending: ReturnType<typeof observe<string>> | undefined;
			const assertActive = () => {
				signal.throwIfAborted();

				if (!isActive) {
					throw new Error('This read approval has ended.');
				}
			};

			try {
				assertActive();
				await persist(
					Object.freeze<SandboxReadRootPersistence>({
						paths,
						async updateSettings(filename, validate) {
							assertActive();

							if (
								filename === '' ||
								filename === '.' ||
								filename === '..' ||
								pending !== undefined ||
								path.basename(filename) !== filename
							) {
								throw new Error(
									'Select one settings file in the global agent directory.'
								);
							}

							const writing = updateSettings(
								path.join(directory, filename),
								paths,
								validate,
								assertActive
							);

							pending = observe(writing);
							await writing;
						}
					})
				);

				const result = await pending;

				if (result?.kind === 'resolved') {
					return result.value;
				}

				if (result?.kind === 'rejected') {
					throw result.error;
				}

				throw new Error('The provider did not update its settings file.');
			} finally {
				isActive = false;
			}
		} catch (error) {
			const extensionSource = provider.protocol?.extensionSource;

			const failure = new InvalidSandboxConfigError(
				{
					operation: 'configure',
					providerId: provider.id,
					...(extensionSource !== undefined && { extensionSource }),
					detail: { kind: 'config', field: 'settings.readRoots' }
				},
				{ cause: error }
			);

			if (error instanceof ReadRootPersistenceConflict) {
				failure.message = cleanDisplayText(error.message);
			}

			throw failure;
		}
	};
}
