import { constants } from 'node:fs';
import { access, open, stat } from 'node:fs/promises';

const [operation, filename, limit] = process.argv.slice(1);

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
			await access(filename, constants.R_OK);
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
