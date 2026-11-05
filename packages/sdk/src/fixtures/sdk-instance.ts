import { createJiti } from 'jiti';

import type {
	ApprovalDeniedError,
	getOutsideSandboxExecutor,
	initialiseSandboxHost,
	isApprovalError,
	isSandboxError,
	registerApprovalPolicy,
	requestExecutionApproval,
	SandboxCancelledError,
	SandboxClient,
	SandboxOperationError
} from '../api.js';
import { isRecord } from '../validation.js';

interface FixtureApi extends SandboxClient {
	readonly SandboxCancelledError: typeof SandboxCancelledError;
	readonly registerApprovalPolicy: typeof registerApprovalPolicy;
	readonly requestExecutionApproval: typeof requestExecutionApproval;
	readonly getOutsideSandboxExecutor: typeof getOutsideSandboxExecutor;
	readonly isApprovalError: typeof isApprovalError;
	readonly ApprovalDeniedError: typeof ApprovalDeniedError;
	readonly initialiseSandboxHost: typeof initialiseSandboxHost;
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
		typeof value.SandboxOperationError === 'function' &&
		typeof value.SandboxCancelledError === 'function' &&
		typeof value.registerApprovalPolicy === 'function' &&
		typeof value.requestExecutionApproval === 'function' &&
		typeof value.getOutsideSandboxExecutor === 'function' &&
		typeof value.isApprovalError === 'function' &&
		typeof value.ApprovalDeniedError === 'function' &&
		typeof value.initialiseSandboxHost === 'function'
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
