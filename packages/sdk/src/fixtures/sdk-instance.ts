import { createJiti } from 'jiti';

import type {
	closeSandboxSession,
	createSandboxClient,
	initialiseSandboxHost,
	isSandboxError,
	registerSandboxProvider,
	SandboxCancelledError,
	SandboxOperationError
} from '../api.js';
import { isRecord } from '../validation.js';

export interface FixtureApi {
	readonly createSandboxClient: typeof createSandboxClient;
	readonly closeSandboxSession: typeof closeSandboxSession;
	readonly registerSandboxProvider: typeof registerSandboxProvider;
	readonly SandboxCancelledError: typeof SandboxCancelledError;
	readonly initialiseSandboxHost: typeof initialiseSandboxHost;
	readonly isSandboxError: typeof isSandboxError;
	readonly SandboxOperationError: typeof SandboxOperationError;
}

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

export function loadIsolatedModule(entry: 'api' | 'service'): Promise<unknown> {
	const loader = createJiti(import.meta.url, {
		moduleCache: false,
		tryNative: false
	});

	return loader.import(`../${entry}.ts`);
}

export async function loadSdkInstance(): Promise<FixtureApi> {
	const module = await loadIsolatedModule('api');

	if (!isFixtureApi(module)) {
		throw new TypeError(
			'The SDK does not export the consumer, registration and error APIs.'
		);
	}

	return module;
}
