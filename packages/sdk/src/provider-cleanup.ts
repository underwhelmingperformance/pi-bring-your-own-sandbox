import { DEFAULT_CLEANUP_BUDGETS } from './cleanup-budgets.js';
import type { SandboxOperationContext } from './contracts.js';

/**
Create a context for releasing resources after work completes or is interrupted.
The context starts with the configured grace period and uses the parent's
cleanup deadline as soon as the broker publishes it. All commands in the
cleanup share the same context and deadline.
*/
export function createSandboxCleanupContext(
	context: Pick<SandboxOperationContext, 'reportWarning' | 'operationId'> &
		Partial<Pick<SandboxOperationContext, 'cleanup' | 'cleanupBudgets'>>,
	operationId = `${context.operationId}:cleanup`,
	monotonicNow: () => number = () => performance.now()
): SandboxOperationContext {
	const cleanupBudgets = context.cleanupBudgets ?? DEFAULT_CLEANUP_BUDGETS;
	const grace = cleanupBudgets.cancellationGraceMs;
	const fallback = Date.now() + grace;
	const expiresAt = monotonicNow() + grace;
	const remainingMs = () =>
		context.cleanup?.remainingMs() ?? Math.max(0, expiresAt - monotonicNow());
	const deadline = () => context.cleanup?.deadline ?? fallback;

	return {
		remainingMs,
		reportWarning: context.reportWarning,
		cleanupBudgets,
		cleanup: Object.freeze({
			remainingMs,
			get deadline() {
				return deadline();
			}
		}),
		operationId,
		signal: new AbortController().signal,
		get deadline() {
			return deadline();
		}
	};
}
