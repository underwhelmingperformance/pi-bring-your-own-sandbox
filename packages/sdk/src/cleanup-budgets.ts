import { Type } from 'typebox';

import type { SandboxCleanupBudgets } from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { checker } from './schemas.js';

const budgetSchema = Type.Integer({ minimum: 1, maximum: 300_000 });

export const cleanupBudgetsSchema = Type.Object(
	{
		cancellationGraceMs: budgetSchema,
		disposalTimeoutMs: budgetSchema
	},
	{ additionalProperties: false }
);
export const cleanupSelectionSchema = Type.Partial(cleanupBudgetsSchema);
export const DEFAULT_CLEANUP_BUDGETS: SandboxCleanupBudgets = Object.freeze({
	cancellationGraceMs: 5000,
	disposalTimeoutMs: 10_000
});

const isCleanupBudgets = checker(cleanupBudgetsSchema);

export function resolveCleanupBudgets(
	input?: Partial<SandboxCleanupBudgets>
): SandboxCleanupBudgets {
	const value = { ...DEFAULT_CLEANUP_BUDGETS, ...input };

	if (!isCleanupBudgets(value)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	return Object.freeze(value);
}
