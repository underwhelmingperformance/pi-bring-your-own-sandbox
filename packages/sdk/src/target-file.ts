import { isUtf8 } from 'node:buffer';
import { constants } from 'node:fs';
import { access, mkdir, open, readdir, stat } from 'node:fs/promises';

const [operation, filename, limit, mode, readLimit] = process.argv.slice(1);

class ReadLimitError extends Error {}

async function read(
	filename: string,
	transferLimit: number,
	maxBytes: number | undefined
): Promise<void> {
	const limit = Math.min(transferLimit, maxBytes ?? transferLimit);

	const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);

	try {
		const metadata = await file.stat();

		if (!metadata.isFile()) {
			throw new TypeError('The target must be a regular file.');
		}

		let size = 0;

		const buffer = Buffer.alloc(64 * 1024);

		for (;;) {
			const length = Math.min(buffer.length, limit - size + 1);
			const { bytesRead } = await file.read(buffer, 0, length);

			if (bytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, bytesRead);

			size += chunk.byteLength;

			if (size > limit) {
				if (maxBytes !== undefined && maxBytes <= transferLimit) {
					throw new ReadLimitError(
						'The file exceeded the requested byte limit.'
					);
				}

				throw new RangeError('The file exceeded the transfer limit.');
			}

			await new Promise<void>((resolve, reject) => {
				process.stdout.write(chunk, (error) => {
					if (error) {
						reject(error);

						return;
					}

					resolve();
				});
			});
		}
	} finally {
		await file.close();
	}
}

try {
	if (filename === undefined) {
		throw new TypeError('Missing file path.');
	}

	switch (operation) {
		case 'access': {
			await access(
				filename,
				mode === 'write' ? constants.W_OK : constants.R_OK
			);
			break;
		}

		case 'stat': {
			const meta = await stat(filename);

			process.stdout.write(
				JSON.stringify({
					kind: meta.isFile()
						? 'file'
						: meta.isDirectory()
							? 'directory'
							: 'other',
					size: meta.size
				})
			);
			break;
		}

		case 'mkdir': {
			await mkdir(filename, { recursive: true });
			break;
		}

		case 'writeFile': {
			const length = Number(mode);
			const chunks: Uint8Array[] = [];
			let received = 0;

			for await (const chunk of process.stdin) {
				if (!(chunk instanceof Uint8Array)) {
					throw new TypeError('Invalid input.');
				}

				received += chunk.byteLength;

				if (received > length || received > Number(limit)) {
					throw new RangeError('Input exceeds the transfer limit.');
				}

				chunks.push(chunk);
			}

			if (received !== length) {
				throw new Error('Incomplete file input.');
			}

			await using target = await open(
				filename,
				constants.O_WRONLY | constants.O_NONBLOCK | constants.O_CREAT
			);

			const stat = await target.stat();

			if (!stat.isFile()) {
				throw new TypeError('The destination must be a regular file.');
			}

			await target.truncate(0);
			await target.writeFile(Buffer.concat(chunks));
			break;
		}

		case 'listDirectory': {
			const entries = await readdir(filename, {
				withFileTypes: true,
				encoding: 'buffer'
			});

			process.stdout.write(
				JSON.stringify(
					entries
						.filter((entry) => isUtf8(entry.name))
						.map((entry) => ({
							name: entry.name.toString('utf8'),
							kind: entry.isSymbolicLink()
								? 'symlink'
								: entry.isDirectory()
									? 'directory'
									: entry.isFile()
										? 'file'
										: 'other'
						}))
				)
			);
			break;
		}

		case 'readFile': {
			await read(
				filename,
				Number(limit),
				readLimit === undefined ? undefined : Number(readLimit)
			);
			break;
		}

		default: {
			throw new Error('Unknown file operation.');
		}
	}
} catch (error) {
	const code =
		error instanceof Error && 'code' in error ? error.code : undefined;

	if (error instanceof ReadLimitError) {
		process.exitCode = 44;
	} else if (code === 'ENOENT' || code === 'ENOTDIR') {
		process.exitCode = 40;
	} else if (
		typeof code === 'string' &&
		['EPERM', 'EACCES', 'EROFS'].includes(code)
	) {
		process.exitCode = 41;
	} else {
		process.exitCode = 42;
	}
}
