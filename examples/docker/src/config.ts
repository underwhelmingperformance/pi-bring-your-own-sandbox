import path from 'node:path';

import { InvalidSandboxConfigError } from 'pi-bring-your-own-sandbox/api';

import type { DockerConfig } from './contracts.js';

/**
Validates local connection settings without contacting Docker or allocating resources.
*/
export function dockerConfig(input: unknown): DockerConfig {
	if (typeof input !== 'object' || input === null || Array.isArray(input)) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId: 'example.docker'
		});
	}

	const keys = Object.keys(input);
	const socketPath =
		'socketPath' in input ? input.socketPath : '/var/run/docker.sock';
	const executable =
		'executable' in input ? input.executable : '/usr/bin/docker';

	if (
		typeof socketPath !== 'string' ||
		typeof executable !== 'string' ||
		socketPath.includes('\0') ||
		executable.includes('\0') ||
		!path.posix.isAbsolute(socketPath) ||
		!path.isAbsolute(executable) ||
		keys.some((key) => key !== 'socketPath' && key !== 'executable')
	) {
		throw new InvalidSandboxConfigError(
			{ operation: 'configure', providerId: 'example.docker' },
			{
				cause: new TypeError(
					'Set executable and socketPath to absolute local paths.'
				)
			}
		);
	}

	return { socketPath, executable };
}
