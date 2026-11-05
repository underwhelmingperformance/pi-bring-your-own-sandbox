import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { spawn } from 'node:child_process';

import { SandboxTransportError } from 'pi-bring-your-own-sandbox/api';

import type {
	DockerClient,
	DockerCommand,
	DockerCommandResult,
	DockerConfig
} from './contracts.js';
import { DeadlineTimer } from './deadline.js';

/**
Creates the local Docker CLI in its own POSIX process group with piped stdio.
Implementations must preserve the supplied process options.
*/
export type DockerSpawn = (
	executable: string,
	arguments_: readonly string[],
	options: {
		readonly env: NodeJS.ProcessEnv;
		readonly stdio: 'pipe';
		readonly shell: false;
		readonly detached: true;
	}
) => ChildProcessWithoutNullStreams;

/**
Signals a local process or POSIX process group. Negative IDs refer to groups.
*/
export interface DockerProcessSignals {
	/**
	Send a signal without waiting for process completion.
	*/
	readonly kill: (id: number, signal: NodeJS.Signals) => void;
}

const nativeSignals: DockerProcessSignals = {
	kill(id, signal) {
		process.kill(id, signal);
	}
};

/**
Runs the CLI against one explicit Unix socket without inheriting Docker settings.
*/
export class NodeDockerClient implements DockerClient {
	readonly #configuration: DockerConfig;
	readonly #spawn: DockerSpawn;
	readonly #signals: DockerProcessSignals;

	/**
	Uses the supplied process and signal dependencies for local CLI management.
	Test launchers must create a separate POSIX process group and provide matching
	signal handling.
	*/
	constructor(
		config: DockerConfig,
		spawnProcess: DockerSpawn = spawn,
		signals: DockerProcessSignals = nativeSignals
	) {
		this.#configuration = { ...config };
		this.#spawn = spawnProcess;
		this.#signals = signals;
	}

	/**
	Enforces the CLI deadline and bounds captured management output to 1 MiB.
	Target cancellation uses the daemon. Terminating the local CLI does not stop a job.
	*/
	command(command: DockerCommand): Promise<DockerCommandResult> {
		const identity = {
			operation: command.operation,
			providerId: 'example.docker',
			recovery: command.recovery
		};
		const failure = (cause: unknown) =>
			new SandboxTransportError(identity, { cause });

		if (command.context.remainingMs() <= 0) {
			return Promise.reject(
				failure(new Error('The Docker CLI deadline has expired.'))
			);
		}

		let child: ChildProcessWithoutNullStreams;

		try {
			child = this.#spawn(
				this.#configuration.executable,
				[`--host=unix://${this.#configuration.socketPath}`, ...command.args],
				{ env: {}, stdio: 'pipe', shell: false, detached: true }
			);
		} catch (error) {
			return Promise.reject(failure(error));
		}

		child.stdin.end();

		const pending = Promise.withResolvers<DockerCommandResult>();
		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		let remaining = 1_048_576;
		let isFinished = false;

		const stop = (cause: unknown) => {
			if (isFinished) {
				return;
			}

			isFinished = true;
			timer.dispose();
			command.context.deadlineChanged?.removeEventListener(
				'abort',
				refreshDeadline
			);

			if (child.pid !== undefined) {
				try {
					this.#signals.kill(-child.pid, 'SIGKILL');
				} catch (error) {
					if (!(
						error instanceof Error &&
						'code' in error &&
						error.code === 'ESRCH'
					)) {
						cause = new AggregateError(
							[cause, error],
							'The Docker CLI process group could not be stopped.'
						);
					}
				}
			}

			child.stdin.destroy();
			child.stdout.destroy();
			child.stderr.destroy();
			child.unref();
			pending.reject(failure(cause));
		};

		const timer = new DeadlineTimer(command.context.remainingMs, () => {
			stop(new Error('The Docker CLI did not finish before its deadline.'));
		});
		const refreshDeadline = () => {
			timer.reset();
		};

		command.context.deadlineChanged?.addEventListener(
			'abort',
			refreshDeadline,
			{
				once: true
			}
		);

		const deliver = (stream: 'stdout' | 'stderr', bytes: Uint8Array) => {
			if (isFinished) {
				return;
			}

			try {
				if (command.onOutput !== undefined) {
					command.onOutput({ stream, data: bytes });

					return;
				}

				if (bytes.byteLength > remaining) {
					stop(new Error('Docker management output exceeded 1 MiB.'));

					return;
				}

				remaining -= bytes.byteLength;
				(stream === 'stdout' ? stdout : stderr).push(new Uint8Array(bytes));
			} catch (error_) {
				stop(error_);
			}
		};

		child.stdout.on('data', (bytes: Buffer) => {
			deliver('stdout', bytes);
		});
		child.stderr.on('data', (bytes: Buffer) => {
			deliver('stderr', bytes);
		});
		child.on('error', stop);
		child.on('close', (status) => {
			if (isFinished) {
				return;
			}

			isFinished = true;
			timer.dispose();
			command.context.deadlineChanged?.removeEventListener(
				'abort',
				refreshDeadline
			);

			if (status === null || command.context.remainingMs() <= 0) {
				pending.reject(failure(undefined));

				return;
			}

			pending.resolve({
				status,
				stdout: new Uint8Array(Buffer.concat(stdout)),
				stderr: new Uint8Array(Buffer.concat(stderr))
			});
		});

		return pending.promise;
	}
}
