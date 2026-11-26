import { createHash } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import { constants } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import {
	chmod,
	chown,
	lchown,
	link,
	lutimes,
	mkdir,
	open,
	opendir,
	readlink,
	symlink,
	utimes
} from 'node:fs/promises';
import path from 'node:path';

const byteLimit = 512 * 1024 * 1024;
const entryLimit = 100_000;
// Linux O_PATH pins the inode without opening a device or waiting on a FIFO.
const pathOnly = 0o1000_0000;
const manifest = new Map<string, string>();
const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true });

class ImportFailure extends Error {
	readonly status: number;

	constructor(status: number, message: string) {
		super(message);
		this.status = status;
	}
}

class ImportPass {
	#bytes = 0;
	#entries = 0;
	readonly #linkedFiles = new Map<
		string,
		{ expected: bigint; paths: number; target: string; content: string }
	>();
	readonly #copy: boolean;

	constructor(shouldCopy: boolean) {
		this.#copy = shouldCopy;
	}

	async file(source: string, target: string, size: bigint): Promise<string> {
		if (size > BigInt(byteLimit - this.#bytes)) {
			throw new RangeError('Workspace contents exceed 512 MiB.');
		}

		await using input = await open(
			source,
			constants.O_RDONLY | constants.O_NONBLOCK
		);

		const output = this.#copy ? await open(target, 'wx') : undefined;
		const hash = createHash('sha256');

		try {
			const stream = input.createReadStream({ autoClose: false });

			for await (const chunk of stream) {
				if (!Buffer.isBuffer(chunk)) {
					throw new TypeError('Invalid input bytes.');
				}

				this.#bytes += chunk.length;

				if (this.#bytes > byteLimit) {
					throw new RangeError('Workspace contents exceed 512 MiB.');
				}

				hash.update(chunk);
				await output?.writeFile(chunk);
			}

			return hash.digest('hex');
		} finally {
			await output?.close();
		}
	}

	async visit(source: string, relative: string, depth: number): Promise<void> {
		this.#entries++;

		if (this.#entries > entryLimit || depth > 128) {
			throw new RangeError(
				'Workspace exceeds the import entry or depth limit.'
			);
		}

		await using pinned = await open(source, pathOnly | constants.O_NOFOLLOW);

		const stat = await pinned.stat({ bigint: true });
		const descriptor = '/proc/self/fd/' + String(pinned.fd);
		const target = path.join('/workspace', relative);
		let content = '';

		if (stat.isDirectory()) {
			if (this.#copy && depth > 0) {
				await mkdir(target);
			}

			const directory = await opendir(descriptor, { encoding: 'latin1' });

			for await (const entry of directory) {
				const basename = decoder.decode(Buffer.from(entry.name, 'latin1'));

				await this.visit(
					path.join(descriptor, basename),
					path.join(relative, basename),
					depth + 1
				);
			}
		} else if (stat.isFile()) {
			content = await this.regularFile(descriptor, target, stat);
		} else if (stat.isSymbolicLink()) {
			const link = await readlink(source, { encoding: 'buffer' });

			content = link.toString('base64');

			if (this.#copy) {
				await symlink(link, target);
				await lchown(target, 65_534, 65_534);
				await lutimes(
					target,
					Number(stat.atimeMs) / 1000,
					Number(stat.mtimeMs) / 1000
				);
			}
		}

		if ((stat.isDirectory() || stat.isFile()) && this.#copy) {
			await chown(target, 65_534, 65_534);
			await chmod(target, Number(stat.mode & 0o777n));
			await utimes(
				target,
				Number(stat.atimeMs) / 1000,
				Number(stat.mtimeMs) / 1000
			);
		}

		await this.record(relative, stat, pinned, content);
	}

	async regularFile(
		source: string,
		target: string,
		stat: BigIntStats
	): Promise<string> {
		if (stat.nlink === 1n) {
			return this.file(source, target, stat.size);
		}

		const key = String(stat.dev) + '/' + String(stat.ino);
		const existing = this.#linkedFiles.get(key);

		if (existing === undefined) {
			const content = await this.file(source, target, stat.size);

			this.#linkedFiles.set(key, {
				expected: stat.nlink,
				paths: 1,
				target,
				content
			});

			return content;
		}

		existing.paths++;

		if (
			stat.nlink !== existing.expected ||
			BigInt(existing.paths) > existing.expected
		) {
			throw new ImportFailure(42, 'The workspace changed during import.');
		}

		if (this.#copy) {
			await link(existing.target, target);
		}

		return existing.content;
	}

	async record(
		relative: string,
		stat: BigIntStats,
		pinned: FileHandle,
		content: string
	) {
		const signature = (meta: BigIntStats) =>
			[
				meta.dev,
				meta.ino,
				meta.mode,
				meta.nlink,
				meta.size,
				meta.mtimeNs,
				meta.ctimeNs
			].join('/');
		const before = signature(stat);
		const value = before + '/' + content;

		if (before !== signature(await pinned.stat({ bigint: true }))) {
			throw new ImportFailure(42, 'The workspace changed during import.');
		}

		if (this.#copy) {
			manifest.set(relative, value);
		} else if (manifest.get(relative) !== value) {
			throw new ImportFailure(42, 'The workspace changed during import.');
		}
	}

	async run() {
		await this.visit('/source', '', 0);

		if (!this.#copy && this.#entries !== manifest.size) {
			throw new ImportFailure(42, 'The workspace changed during import.');
		}
	}
}

try {
	await new ImportPass(true).run();

	await new ImportPass(false).run();
} catch (error) {
	process.exitCode =
		error instanceof RangeError
			? 43
			: error instanceof ImportFailure
				? error.status
				: error instanceof TypeError &&
					  'code' in error &&
					  error.code === 'ERR_ENCODING_INVALID_ENCODED_DATA'
					? 45
					: 46;
}
