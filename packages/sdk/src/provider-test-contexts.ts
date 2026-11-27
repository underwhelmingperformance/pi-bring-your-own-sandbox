import { randomUUID } from 'node:crypto';

import { resolveCleanupBudgets } from './cleanup-budgets.js';
import type {
	BackendProcessContext,
	SandboxCleanupBudgets,
	SandboxOpenContext,
	SandboxOperationContext
} from './contracts.js';

export interface SandboxTestContextOptions {
	readonly operationId?: string;
	readonly signal?: AbortSignal;
	readonly timeoutMs?: number;
	readonly cleanup?: Partial<SandboxCleanupBudgets>;
	readonly reportWarning?: SandboxOperationContext['reportWarning'];
}

function ignoreEvent(): void {
	return;
}

/**
Create an operation context for a direct provider test.
*/
export function createSandboxOperationContext(
	options: SandboxTestContextOptions = {}
): SandboxOperationContext {
	const timeoutMs = options.timeoutMs ?? 10_000;
	const timeout = AbortSignal.timeout(timeoutMs);
	const started = performance.now();
	const cleanupBudgets = resolveCleanupBudgets(options.cleanup);

	return {
		operationId: options.operationId ?? randomUUID(),
		signal: options.signal
			? AbortSignal.any([options.signal, timeout])
			: timeout,
		deadline: Date.now() + timeoutMs,
		remainingMs: () => Math.max(0, timeoutMs - (performance.now() - started)),
		cleanup: {
			deadline: undefined,
			remainingMs(): undefined {
				return;
			}
		},
		cleanupBudgets,
		reportWarning: options.reportWarning ?? ignoreEvent
	};
}

/**
Create an open context and optionally observe recovery and cleanup.
*/
export function createSandboxOpenContext(
	options: SandboxTestContextOptions & {
		readonly reportRecovery?: SandboxOpenContext['reportRecovery'];
		readonly confirmCleanup?: SandboxOpenContext['confirmCleanup'];
	} = {}
): SandboxOpenContext {
	return {
		...createSandboxOperationContext(options),
		reportRecovery: options.reportRecovery ?? ignoreEvent,
		confirmCleanup: options.confirmCleanup ?? ignoreEvent
	};
}

/**
Create an execution context and optionally consume the output stream.
*/
export function createBackendProcessContext(
	options: SandboxTestContextOptions & {
		readonly onOutput?: BackendProcessContext['onOutput'];
	} = {}
): BackendProcessContext {
	return {
		...createSandboxOperationContext(options),
		onOutput: options.onOutput ?? ignoreEvent
	};
}
