import type { TerminationScope } from './contracts.js';

const strength: Readonly<Record<TerminationScope, number>> = {
	'process-group': 1,
	workload: 2
};

export function isTerminationScopeSatisfied(
	effective: TerminationScope,
	required: TerminationScope
): boolean {
	return strength[effective] >= strength[required];
}
