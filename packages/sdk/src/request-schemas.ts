import type { TSchema } from 'typebox';
import { Type } from 'typebox';
import { Value } from 'typebox/value';

import { cleanupSelectionSchema } from './cleanup-budgets.js';
import type { ProcessOptions } from './contracts.js';
import { accessPolicySchema, accessSchema } from './policy-model.js';
import {
	callable,
	capabilitySchema,
	denseArray,
	nonNegativeIntegerSchema,
	positiveIntegerSchema,
	processKindSchema,
	safeTextSchema,
	shellSchema,
	signalSchema,
	targetPathSchema,
	terminationScopeSchema,
	timeoutSchema
} from './schemas.js';

export const MAX_CAPTURE_BYTES = 1_048_576;

export const sharedSettingsSchema = Type.Object(
	{
		policy: Type.Optional(accessPolicySchema),
		allowEscalation: Type.Optional(Type.Boolean({ default: true })),
		userShell: Type.Optional(shellSchema),
		readRoots: Type.Optional(denseArray(targetPathSchema)),
		cleanup: Type.Optional(cleanupSelectionSchema)
	},
	{ additionalProperties: false }
);
export const providerConfigSchema = Type.Object(
	{
		configuration: Type.Unknown(),
		settings: Type.Optional(sharedSettingsSchema)
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

export const readOptionsSchema = Type.Object(
	{
		...operationOptionsSchema.properties,
		maxBytes: Type.Optional(nonNegativeIntegerSchema)
	},
	{ additionalProperties: false }
);

const onOutput = callable<NonNullable<ProcessOptions['onOutput']>>(
	[Type.Ref('sandbox.processOutput')],
	Type.Undefined()
);

export const processOptionsSchema = Type.Object(
	{
		...operationOptionsSchema.properties,
		maxCaptureBytes: Type.Optional(
			Type.Integer({ minimum: 0, maximum: MAX_CAPTURE_BYTES })
		),
		onOutput: Type.Optional(onOutput)
	},
	{ additionalProperties: false }
);

export const requirementsSchema = Type.Object(
	{
		terminationScope: Type.Optional(terminationScopeSchema),
		processKinds: Type.Optional(
			denseArray(processKindSchema, { uniqueItems: true })
		),
		shells: Type.Optional(denseArray(shellSchema, { uniqueItems: true })),
		exitStatus: Type.Optional(Type.Literal('guaranteed')),
		capabilities: Type.Optional(
			denseArray(capabilitySchema, { uniqueItems: true })
		),
		access: Type.Optional(accessSchema)
	},
	{ additionalProperties: false }
);

export const acquireOptionsSchema = Type.Object(
	{ ...requirementsSchema.properties, ...operationOptionsSchema.properties },
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

export function invalidField(
	schema: TSchema,
	input: unknown
): readonly string[] {
	const [issue] = Value.Errors(schema, input);

	if (issue === undefined) {
		return [];
	}

	const keys = issue.instancePath
		.split('/')
		.slice(1)
		.map((key) => key.replaceAll('~1', '/').replaceAll('~0', '~'));

	if (issue.keyword === 'additionalProperties') {
		const [extra] = issue.params.additionalProperties;

		if (extra !== undefined) {
			keys.push(extra);
		}
	} else if (issue.keyword === 'required') {
		const [missing] = issue.params.requiredProperties;

		if (missing !== undefined) {
			keys.push(missing);
		}
	}

	return keys;
}
