import { constants } from 'node:fs';
import {
	access,
	mkdir,
	open,
	readdir,
	stat,
	writeFile
} from 'node:fs/promises';

const [operation, filename, limit, mode] = process.argv.slice(1);

async function read(filename: string, limit: number): Promise<void> {
	const file = await open(filename, constants.O_RDONLY | constants.O_NONBLOCK);

	try {
		const metadata = await file.stat();

		if (!metadata.isFile() || metadata.size > limit) {
			throw new RangeError(
				'The target must be a regular file within the transfer limit.'
			);
		}

		let size = 0;

		const buffer = Buffer.alloc(64 * 1024);

		for (;;) {
			const { bytesRead } = await file.read(buffer);

			if (bytesRead === 0) {
				break;
			}

			const chunk = buffer.subarray(0, bytesRead);

			size += chunk.byteLength;

			if (size > limit) {
				throw new RangeError(
					'The file exceeded the transfer limit during the read.'
				);
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

			await writeFile(filename, Buffer.concat(chunks));
			break;
		}

		case 'listDirectory': {
			const entries = await readdir(filename, { withFileTypes: true });

			process.stdout.write(
				JSON.stringify(
					entries.map((entry) => ({
						name: entry.name,
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
			await read(filename, Number(limit));
			break;
		}

		default: {
			throw new Error('Unknown file operation.');
		}
	}
} catch (error) {
	const code =
		error instanceof Error && 'code' in error ? error.code : undefined;

	process.exitCode =
		code === 'ENOENT' || code === 'ENOTDIR'
			? 40
			: typeof code === 'string' && ['EPERM', 'EACCES', 'EROFS'].includes(code)
				? 41
				: 42;
}
