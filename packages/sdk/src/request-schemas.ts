import { Type } from 'typebox';

import { cleanupSelectionSchema } from './cleanup-budgets.js';
import type { ProcessOptions } from './contracts.js';
import {
	accessSchema,
	callable,
	capabilitySchema,
	denseArray,
	guaranteeSchema,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	policySchema,
	positiveIntegerSchema,
	processKindSchema,
	safeTextSchema,
	shellSchema,
	signalSchema,
	targetPathSchema,
	terminationScopeSchema,
	timeoutSchema,
	workspaceProtectionSchema,
	workspaceRelationshipSchema
} from './schemas.js';

export const MAX_CAPTURE_BYTES = 1_048_576;

export const approvalSelectionSchema = Type.Object(
	{ policy: nonEmptyStringSchema, config: Type.Optional(Type.Unknown()) },
	{ additionalProperties: false }
);
export const outsideSelectionSchema = Type.Object(
	{
		destination: Type.Union([Type.Literal('normal'), Type.Literal('provider')])
	},
	{ additionalProperties: false }
);
export const providerConfigSchema = Type.Object(
	{
		configuration: Type.Unknown(),
		policy: Type.Optional(policySchema),
		userShell: Type.Optional(shellSchema),
		cleanup: Type.Optional(cleanupSelectionSchema)
	},
	{ additionalProperties: false }
);

export const environmentSchema = Type.Record(
	Type.String({ pattern: '^[^\\u0000=]+$' }),
	Type.Union([safeTextSchema, Type.Null()]),
	{ additionalProperties: false }
);

const location = {
	cwd: Type.Optional(targetPathSchema),
	env: Type.Optional(environmentSchema)
};

export const processRequestSchema = Type.Union([
	Type.Object(
		{
			...location,
			kind: Type.Literal('argv'),
			executable: targetPathSchema,
			args: denseArray(safeTextSchema)
		},
		{ additionalProperties: false }
	),
	Type.Object(
		{
			...location,
			kind: Type.Literal('shell'),
			command: safeTextSchema,
			dialect: shellSchema
		},
		{ additionalProperties: false }
	)
]);

export const operationOptionsSchema = Type.Object(
	{
		signal: Type.Optional(signalSchema),
		timeoutMs: Type.Optional(timeoutSchema)
	},
	{ additionalProperties: false }
);

export const processOptionsSchema = Type.Object(
	{
		...operationOptionsSchema.properties,
		maxCaptureBytes: Type.Optional(
			Type.Integer({ minimum: 0, maximum: MAX_CAPTURE_BYTES })
		),
		onOutput: Type.Optional(callable<NonNullable<ProcessOptions['onOutput']>>())
	},
	{ additionalProperties: false }
);

export const writeOptionsSchema = Type.Object(
	{
		...operationOptionsSchema.properties,
		createParents: Type.Optional(Type.Boolean())
	},
	{ additionalProperties: false }
);

export const acquireOptionsSchema = Type.Object(
	{
		terminationScope: Type.Optional(terminationScopeSchema),
		...operationOptionsSchema.properties,
		processKinds: Type.Optional(
			denseArray(processKindSchema, { uniqueItems: true })
		),
		shells: Type.Optional(denseArray(shellSchema, { uniqueItems: true })),
		exitStatus: Type.Optional(Type.Literal('guaranteed')),
		capabilities: Type.Optional(
			denseArray(capabilitySchema, { uniqueItems: true })
		),
		guarantees: Type.Optional(
			denseArray(guaranteeSchema, { uniqueItems: true })
		),
		needs: Type.Optional(denseArray(accessSchema, { uniqueItems: true })),
		workspaceRelationship: Type.Optional(workspaceRelationshipSchema),
		workspaceProtection: Type.Optional(workspaceProtectionSchema)
	},
	{ additionalProperties: false }
);

export const sandboxRequirementsSchema = Type.Object(
	{
		...Type.Omit(acquireOptionsSchema, ['signal', 'timeoutMs']).properties,
		providerId: Type.Optional(nonEmptyStringSchema)
	},
	{ additionalProperties: false }
);

export const findRequestSchema = Type.Object(
	{
		pattern: safeTextSchema,
		path: Type.Optional(targetPathSchema),
		limit: Type.Optional(Type.With(positiveIntegerSchema, { default: 1000 }))
	},
	{ additionalProperties: false }
);

const defaultFalseSchema = Type.With(Type.Boolean(), { default: false });

export const grepRequestSchema = Type.Object(
	{
		...findRequestSchema.properties,
		limit: Type.Optional(Type.With(positiveIntegerSchema, { default: 100 })),
		context: Type.Optional(Type.With(nonNegativeIntegerSchema, { default: 0 })),
		glob: Type.Optional(safeTextSchema),
		literal: Type.Optional(defaultFalseSchema),
		ignoreCase: Type.Optional(defaultFalseSchema)
	},
	{ additionalProperties: false }
);

export const accessModeSchema = Type.Union([
	Type.Literal('read'),
	Type.Literal('write')
]);
