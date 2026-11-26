import { Type } from 'typebox';

import { acquireOptions } from './acquire-options.js';
import { settleSandboxClose } from './cleanup-report.js';
import type {
	SandboxCloseReport,
	SandboxCopyOptions,
	SandboxErrorContext
} from './contracts.js';
import { InvalidSandboxRequestError, SandboxCleanupError } from './errors.js';
import type { CopySourceIdentity } from './protocol.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

const hostSource = Type.Object(
	{ kind: Type.Literal('host') },
	{ additionalProperties: false }
);
const sandboxSource = Type.Object(
	{
		kind: Type.Literal('sandbox'),
		providerId: nonEmptyStringSchema,
		generationId: nonEmptyStringSchema,
		backendId: nonEmptyStringSchema
	},
	{ additionalProperties: false }
);
const isSource = checker(Type.Union([hostSource, sandboxSource]));

export function copySource(input: unknown): CopySourceIdentity {
	if (!isSource(input)) {
		throw new InvalidSandboxRequestError({ operation: 'acquire' });
	}

	return Object.freeze({ ...input });
}

export function copyOptions(input: unknown): SandboxCopyOptions {
	const options = acquireOptions(input);

	if (options.workspaceRelationship !== undefined) {
		throw new InvalidSandboxRequestError({ operation: 'acquire' });
	}

	return options;
}

export async function rethrowCopyError(
	error: unknown,
	close: () => Promise<SandboxCloseReport>,
	identity: SandboxErrorContext
): Promise<never> {
	const closeReport = await settleSandboxClose(close, identity);

	if (
		!closeReport.confirmed ||
		closeReport.failures.length > 0 ||
		closeReport.recoveries.length > 0
	) {
		throw new SandboxCleanupError(
			{ ...identity, closeReport },
			{ cause: error }
		);
	}

	throw error;
}
