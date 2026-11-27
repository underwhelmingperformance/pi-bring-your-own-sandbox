import { Type } from 'typebox';

import { checkRequirements } from './acquire-options.js';
import { settleSandboxClose } from './cleanup-report.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxCopy,
	SandboxErrorContext
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	SandboxCleanupError
} from './errors.js';
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

export function checkCopiedSandbox(
	sandbox: Sandbox,
	options: SandboxAcquireOptions,
	extensionSource?: string
): void {
	checkRequirements(sandbox, options, extensionSource);

	if (sandbox.workspace.relationship !== 'copied') {
		throw new InvalidSandboxDeclarationError({
			operation: 'acquire',
			providerId: sandbox.providerId,
			backendId: sandbox.backendId,
			...(extensionSource !== undefined && { extensionSource }),
			detail: { kind: 'declaration', field: 'workspace.relationship' }
		});
	}
}

export async function checkedCopy(
	copy: SandboxCopy,
	options: SandboxAcquireOptions,
	extensionSource: string
): Promise<SandboxCopy> {
	try {
		checkCopiedSandbox(copy.sandbox, options, extensionSource);

		return copy;
	} catch (error) {
		return rethrowCopyError(error, () => copy.close(), {
			operation: 'dispose',
			providerId: copy.sandbox.providerId,
			backendId: copy.sandbox.backendId
		});
	}
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
