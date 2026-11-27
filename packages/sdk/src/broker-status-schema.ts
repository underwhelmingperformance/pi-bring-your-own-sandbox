import { Type } from 'typebox';

import { workspaceSchema } from './backend-schemas.js';
import {
	closeReportSchema,
	errorSchema,
	operationSchema
} from './error-schema.js';
import { accessPolicySchema, profileSchema } from './policy-model.js';
import type { SandboxStatus } from './protocol.js';
import { protocolIdentitySchema } from './protocol-envelope.js';
import {
	denseArray,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	shellSchema
} from './schemas.js';

const backendState = Type.Union([
	Type.Literal('opening'),
	Type.Literal('ready'),
	Type.Literal('failed')
]);
const generationState = Type.Union([
	...backendState.anyOf,
	Type.Literal('initialising'),
	Type.Literal('idle'),
	Type.Literal('closing'),
	Type.Literal('closed')
]);

const selection = Type.Object({
	providerId: nonEmptyStringSchema,
	source: Type.Union([Type.Literal('default'), Type.Literal('extension')]),
	policy: accessPolicySchema,
	userShell: Type.Optional(shellSchema)
});

const backendStatus = Type.Object({
	policy: accessPolicySchema,
	effectivePolicy: Type.Optional(accessPolicySchema),
	state: backendState,
	backendId: Type.Optional(nonEmptyStringSchema)
});

const diagnostic = Type.Object({
	message: Type.String({ minLength: 1, maxLength: 2048 }),
	operationId: nonEmptyStringSchema,
	operation: operationSchema,
	providerId: Type.Optional(nonEmptyStringSchema),
	backendId: Type.Optional(nonEmptyStringSchema)
});

const diagnostics = denseArray(diagnostic, { maxItems: 64 });
const backends = denseArray(backendStatus);

export const brokerStatusSchema = Type.Unsafe<SandboxStatus>(
	Type.Object({
		protocol: Type.Optional(protocolIdentitySchema),
		providerLabel: Type.Optional(nonEmptyStringSchema),
		diagnostics: Type.Optional(diagnostics),
		diagnosticsDropped: Type.Optional(nonNegativeIntegerSchema),
		generationId: nonEmptyStringSchema,
		state: generationState,
		selection: Type.Optional(selection),
		backends: Type.Optional(backends),
		backendId: Type.Optional(nonEmptyStringSchema),
		workspace: Type.Optional(workspaceSchema),
		profile: Type.Optional(profileSchema),
		policyDescription: Type.Optional(nonEmptyStringSchema),
		failure: Type.Optional(errorSchema),
		closeReport: Type.Optional(closeReportSchema)
	})
);
