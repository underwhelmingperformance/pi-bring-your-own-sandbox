import path from 'node:path';

import { InvalidSandboxConfigError } from 'pi-bring-your-own-sandbox/provider';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import type { DockerConfig } from './contracts.js';

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

const dockerConfigSchema = Type.Object(
	{
		socketPath: Type.Refine(localPathSchema, (value) =>
			path.posix.isAbsolute(value)
		),
		executable: Type.Refine(localPathSchema, (value) => path.isAbsolute(value))
	},
	{ additionalProperties: false }
);

const configValidator = Compile(dockerConfigSchema);

export const ABSOLUTE_PATHS =
	'Set executable and socketPath to absolute local paths.';

export function dockerConfig(input: unknown): DockerConfig {
	if (!configValidator.Check(input)) {
		throw new InvalidSandboxConfigError(
			{ operation: 'configure', providerId: 'example.docker' },
			{ cause: new TypeError(ABSOLUTE_PATHS) }
		);
	}

	return { socketPath: input.socketPath, executable: input.executable };
}
