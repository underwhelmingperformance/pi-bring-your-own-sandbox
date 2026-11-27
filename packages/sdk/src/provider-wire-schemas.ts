import { Type } from 'typebox';

import { backendSchema } from './backend-schemas.js';
import { hostAbsolutePathSchema } from './context-schemas.js';
import { pathGrantsSchema, profileSchema } from './policy-model.js';
import { denseArray, nonEmptyStringSchema } from './schemas.js';

const canonicalRootsSchema = denseArray(hostAbsolutePathSchema, {
	uniqueItems: true
});

export const providerOpenRequestSchema = Type.Object({
	generationId: nonEmptyStringSchema,
	sessionId: nonEmptyStringSchema,
	hostWorkspace: hostAbsolutePathSchema,
	profile: profileSchema,
	paths: Type.Optional(pathGrantsSchema),
	hostUserDataRoots: Type.Optional(canonicalRootsSchema),
	credentialExclusions: Type.Optional(canonicalRootsSchema)
});

const hostSource = Type.Object({ kind: Type.Literal('host') });
const backendSource = Type.Object({
	kind: Type.Literal('backend'),
	backend: backendSchema
});

export const providerCopyRequestSchema = Type.Object({
	...providerOpenRequestSchema.properties,
	source: Type.Union([hostSource, backendSource])
});
