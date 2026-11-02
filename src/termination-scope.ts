import type { TerminationScope } from './contracts.js';
import type { OperationScope, Settlement } from './lifecycle.js';
import { observe, settleOperation } from './lifecycle.js';

const strength: Readonly<Record<TerminationScope, number>> = {
	none: 0,
	'process-group': 1,
	workload: 2
};

export function isTerminationScopeSatisfied(
	effective: TerminationScope,
	required: TerminationScope
): boolean {
	return strength[effective] >= strength[required];
}

export async function settleProcess<Value>(
	scope: OperationScope,
	promise: Promise<Value>,
	terminationScope: TerminationScope
): Promise<Settlement<Value>> {
	if (terminationScope !== 'none') {
		return settleOperation(scope, promise);
	}

	const result = await Promise.race([observe(promise), scope.whenCancelled()]);

	if (scope.reason !== undefined || result.kind === 'cancelled') {
		return {
			kind: 'rejected',
			error: scope.cancellationError('not-guaranteed')
		};
	}

	return result;
}
