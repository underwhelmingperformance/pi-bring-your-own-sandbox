import { InvalidSandboxConfigError } from 'pi-bring-your-own-sandbox/api';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import type { DockerConfig } from './contracts.js';
import { dockerConfigSchema } from './schemas.js';

const recordValidator = Compile(Type.Record(Type.String(), Type.Unknown()));
const configValidator = Compile(dockerConfigSchema);

/**
Validates local connection settings without contacting Docker or allocating resources.
*/
export function dockerConfig(input: unknown): DockerConfig {
	if (!recordValidator.Check(input)) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId: 'example.docker'
		});
	}

	const value = {
		...input,
		socketPath:
			'socketPath' in input ? input['socketPath'] : '/var/run/docker.sock',
		executable: 'executable' in input ? input['executable'] : '/usr/bin/docker'
	};

	if (!configValidator.Check(value)) {
		throw new InvalidSandboxConfigError(
			{ operation: 'configure', providerId: 'example.docker' },
			{
				cause: new TypeError(
					'Set executable and socketPath to absolute local paths.'
				)
			}
		);
	}

	return { socketPath: value.socketPath, executable: value.executable };
}
