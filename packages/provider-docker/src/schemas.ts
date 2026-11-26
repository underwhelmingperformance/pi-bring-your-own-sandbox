import path from 'node:path';

import { Type } from 'typebox';

const localPathSchema = Type.String({ minLength: 1, pattern: '^[^\\u0000]*$' });
const nonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER
});

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
