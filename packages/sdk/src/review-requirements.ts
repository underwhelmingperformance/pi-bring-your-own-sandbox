import { Type } from 'typebox';

import type {
	ReviewSnapshotSource,
	SandboxAcquireOptions
} from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

export const reviewRequirements = {
	policy: {
		workspaceAccess: 'read-only',
		workspaceRelationship: 'copied',
		filesystemScope: 'workspace-only',
		networkAccess: 'denied'
	},
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
