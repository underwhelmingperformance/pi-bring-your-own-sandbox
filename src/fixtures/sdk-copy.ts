import { cp, mkdir, symlink } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type {
	isSandboxError,
	SandboxClient,
	SandboxOperationError
} from '../api.js';
import { isRecord } from '../validation.js';

interface FixtureApi extends SandboxClient {
	readonly isSandboxError: typeof isSandboxError;
	readonly SandboxOperationError: typeof SandboxOperationError;
}

function isFixtureApi(value: unknown): value is FixtureApi {
	return (
		isRecord(value) &&
		typeof value.getSandbox === 'function' &&
		typeof value.closeSandboxSession === 'function' &&
		typeof value.registerSandboxProvider === 'function' &&
		typeof value.isSandboxError === 'function' &&
		typeof value.SandboxOperationError === 'function'
	);
}

export async function loadSdkCopy(directory: string): Promise<FixtureApi> {
	await cp(new URL('../../dist/', import.meta.url), directory, {
		recursive: true
	});

	const peers = path.join(directory, 'node_modules', '@earendil-works');

	await mkdir(peers, { recursive: true });
	await symlink(
		fileURLToPath(
			new URL(
				'../../node_modules/@earendil-works/pi-coding-agent',
				import.meta.url
			)
		),
		path.join(peers, 'pi-coding-agent'),
		'dir'
	);

	const module: unknown = await import(
		pathToFileURL(path.join(directory, 'api.js')).href
	);

	if (!isFixtureApi(module)) {
		throw new TypeError(
			'The built SDK does not export the consumer, registration and error APIs.'
		);
	}

	return module;
}
