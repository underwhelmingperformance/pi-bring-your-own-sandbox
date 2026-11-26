import { execFile } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type { SandboxConfigContext } from 'pi-bring-your-own-sandbox/provider';
import { InvalidSandboxConfigError } from 'pi-bring-your-own-sandbox/provider';
import { Compile } from 'typebox/compile';

import type { DockerConfig } from './contracts.js';
import { findHostExecutable } from './host-executable.js';
import { dockerConfigSchema } from './schemas.js';

const configValidator = Compile(dockerConfigSchema);
const runDocker = promisify(execFile);
const UNIX_ENDPOINT = 'unix://';
const ABSOLUTE_PATHS = 'Set executable and socketPath to absolute local paths.';

/**
Where to look for the host's Docker installation, and where to report a failed
search.
*/
export interface DockerDiscoveryContext extends Pick<
	SandboxConfigContext,
	'signal' | 'reportDiagnostic'
> {
	/**
	Host workspace. A Docker CLI inside it is never used.
	*/
	readonly workspace: string;
}

function invalid(message: string, cause?: unknown) {
	return new InvalidSandboxConfigError(
		{ operation: 'configure', providerId: 'example.docker' },
		{ cause: new TypeError(message, { cause }) }
	);
}

class DockerDiscovery {
	readonly #context: DockerDiscoveryContext;

	constructor(context: DockerDiscoveryContext) {
		this.#context = context;
	}

	/**
	The SDK drops the cause of a configuration error before the user sees it, so
	the message also goes to the status display as a diagnostic.
	*/
	#fail(message: string, cause?: unknown) {
		this.#context.reportDiagnostic({
			level: 'warning',
			message: `Docker: ${message}`
		});

		return invalid(message, cause);
	}

	async #socket(executable: string): Promise<string> {
		let endpoint: unknown;

		try {
			const { stdout } = await runDocker(
				executable,
				['context', 'inspect', '--format', '{{json .Endpoints.docker.Host}}'],
				{ signal: this.#context.signal }
			);

			endpoint = JSON.parse(stdout);
		} catch (error) {
			throw this.#fail(
				'The Docker CLI did not report its current context. Select a context or set socketPath.',
				error
			);
		}

		const socketPath =
			typeof endpoint === 'string' && endpoint.startsWith(UNIX_ENDPOINT)
				? endpoint.slice(UNIX_ENDPOINT.length)
				: undefined;

		if (socketPath === undefined || !path.posix.isAbsolute(socketPath)) {
			throw this.#fail(
				'The current Docker context does not use a local Unix socket. Select a local context or set socketPath.'
			);
		}

		return socketPath;
	}

	async resolve(input: Partial<DockerConfig>): Promise<DockerConfig> {
		const executable =
			input.executable ??
			(await findHostExecutable(
				'docker',
				await realpath(this.#context.workspace)
			));

		if (executable === undefined) {
			throw this.#fail(
				'Install the Docker CLI on PATH or set executable to its absolute path.'
			);
		}

		if (!path.isAbsolute(executable)) {
			throw this.#fail(ABSOLUTE_PATHS);
		}

		const config = {
			executable,
			socketPath: input.socketPath ?? (await this.#socket(executable))
		};

		if (!configValidator.Check(config)) {
			throw this.#fail(ABSOLUTE_PATHS);
		}

		return config;
	}
}

/**
Validates local connection settings without contacting Docker or allocating resources.
*/
export function dockerConfig(input: unknown): DockerConfig {
	if (!configValidator.Check(input)) {
		throw invalid(ABSOLUTE_PATHS);
	}

	return { socketPath: input.socketPath, executable: input.executable };
}

/**
Fills in omitted connection settings from the host's Docker installation. The
CLI comes from `PATH`, and the socket comes from the CLI's current context,
which follows `DOCKER_HOST` and `DOCKER_CONTEXT`. Neither step contacts the
daemon. Resolve the settings once per session: Docker commands run with the
result and an empty environment, so a later context change does not move the
session to another daemon.
*/
export function resolveDockerConfig(
	input: Partial<DockerConfig>,
	context: DockerDiscoveryContext
): Promise<DockerConfig> {
	return new DockerDiscovery(context).resolve(input);
}
