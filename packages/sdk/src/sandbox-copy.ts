import { Type } from 'typebox';

import { acquireOptions } from './acquire-options.js';
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

export function rethrowCopyError(
	error: unknown,
	report: SandboxCloseReport,
	identity: SandboxErrorContext
): never {
	if (!report.confirmed) {
		const [recovery] = report.recoveries;

		throw new SandboxCleanupError(
			{ ...identity, ...(recovery !== undefined && { recovery }) },
			{ cause: error }
		);
	}

	throw error;
}
