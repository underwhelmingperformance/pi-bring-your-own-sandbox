import { Type } from 'typebox';

import type {
	ReviewSnapshotSource,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxErrorContext,
	SandboxPolicy
} from './contracts.js';
import { InvalidSandboxRequestError, SandboxCleanupError } from './errors.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

export const reviewPolicy = {
	workspaceAccess: 'read-only',
	workspaceRelationship: 'copied',
	filesystemScope: 'workspace-only',
	networkAccess: 'denied'
} as const satisfies SandboxPolicy;

export const reviewRequirements = {
	guarantees: [
		'no-workspace-writes',
		'no-network',
		'no-host-user-data',
		'no-host-system-files'
	],
	workspaceRelationship: 'copied',
	exitStatus: 'guaranteed',
	terminationScope: 'process-group',
	capabilities: ['exec', 'files.read'],
	shells: ['sh'],
	processKinds: ['shell']
} as const satisfies SandboxAcquireOptions;

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

export function snapshotSource(input: unknown): ReviewSnapshotSource {
	if (!isSource(input)) {
		throw new InvalidSandboxRequestError({ operation: 'acquire' });
	}

	return Object.freeze({ ...input });
}

export function rethrowSnapshotError(
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
