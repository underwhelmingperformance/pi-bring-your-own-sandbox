import { createJiti } from 'jiti';

import { isRecord } from '../validation.js';

import type * as api from './sdk-instance-exports.js';

export type FixtureApi = typeof api;

function isFixtureApi(value: unknown): value is FixtureApi {
	return (
		isRecord(value) &&
		typeof value['createSandboxClient'] === 'function' &&
		typeof value['closeSandboxSession'] === 'function' &&
		typeof value['registerSandboxProvider'] === 'function' &&
		typeof value['isSandboxError'] === 'function' &&
		typeof value['SandboxOperationError'] === 'function' &&
		typeof value['SandboxCancelledError'] === 'function' &&
		typeof value['initialiseSandboxHost'] === 'function'
	);
}

export async function loadSdkInstance(): Promise<FixtureApi> {
	const loader = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false
	});

	const module = await loader.import('./sdk-instance-exports.ts');

	if (!isFixtureApi(module)) {
		throw new TypeError(
			'The SDK does not export the consumer, registration and error APIs.'
		);
	}

	return module;
}
