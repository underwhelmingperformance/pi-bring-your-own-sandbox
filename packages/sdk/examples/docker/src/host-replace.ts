import { lstat, rename } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

const staging = process.argv[2];

if (!staging || process.platform !== 'darwin' || !path.isAbsolute(staging)) {
	throw new Error(
		'The macOS replacement service requires a private staging directory.'
	);
}

async function replace(
	stagingDirectory: string,
	request: unknown
): Promise<string> {
	if (!Array.isArray(request) || request.length !== 2) {
		return 'EINVAL';
	}

	const fields: readonly unknown[] = request;
	const [stage, target] = fields;

	if (
		typeof stage !== 'string' ||
		!target ||
		typeof target !== 'string' ||
		!/^\.pi-byos-write-[0-9]+$/u.test(stage) ||
		target.startsWith('.') ||
		target.includes('/') ||
		target.includes('\0') ||
		Buffer.byteLength(target) > 255
	) {
		return 'EINVAL';
	}

	const source = path.join(stagingDirectory, stage);

	try {
		const entry = await lstat(target);
		const replacement = await lstat(source);

		if (
			!entry.isFile() ||
			entry.nlink !== 1 ||
			!replacement.isFile() ||
			replacement.nlink !== 1
		) {
			return 'EACCES';
		}

		await rename(source, target);

		return 'OK';
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			typeof error.code === 'string'
		) {
			return error.code;
		}

		throw error;
	}
}

const requests = createInterface({ input: process.stdin });

for await (const line of requests) {
	const request: unknown = JSON.parse(line);
	const result = await replace(staging, request);

	process.stdout.write(JSON.stringify(result) + '\n');
}
