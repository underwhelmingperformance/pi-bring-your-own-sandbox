import path from 'node:path';

import { Type } from 'typebox';

const localPathSchema = Type.String({ minLength: 1, pattern: '^[^\\u0000]*$' });
const nonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER
});
const signalNumberSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER
});
const exitSchema = Type.Union([
	Type.Object({ kind: Type.Literal('code'), code: nonNegativeIntegerSchema }),
	Type.Object({
		kind: Type.Literal('signal'),
		signal: Type.String({ minLength: 1 }),
		signalNumber: signalNumberSchema
	})
]);
const outputSchema = Type.Object({
	kind: Type.Enum(['stdout', 'stderr']),
	data: Type.Refine(
		Type.String(),
		(value) => Buffer.from(value, 'base64').toString('base64') === value
	)
});

export const launchFrameSchema = Type.Union([
	outputSchema,
	Type.Object({ kind: Type.Literal('exited'), exit: exitSchema }),
	Type.Object({
		kind: Type.Enum(['not-found', 'permission-denied', 'start-failed'])
	})
]);

export const containerStateSchema = Type.Object({
	Running: Type.Boolean(),
	Status: Type.String(),
	ExitCode: nonNegativeIntegerSchema,
	Error: Type.String()
});

export const dockerConfigSchema = Type.Object(
	{
		socketPath: Type.Refine(localPathSchema, (value) =>
			path.posix.isAbsolute(value)
		),
		executable: Type.Refine(localPathSchema, (value) => path.isAbsolute(value))
	},
	{ additionalProperties: false }
);
