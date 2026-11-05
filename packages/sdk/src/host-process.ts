import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessExit,
	ProcessRequest,
	ShellDialect
} from './contracts.js';
import {
	SandboxOperationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { hostError } from './host-error.js';
import { isRecord } from './validation.js';

interface Completion {
	isClosed: boolean;
	exit?: ProcessExit;
	error?: unknown;
}

export interface ProcessSignals {
	readonly kill: (id: number, signal: NodeJS.Signals | 0) => void;
}

const nativeSignals: ProcessSignals = {
	kill(id, signal) {
		process.kill(id, signal);
	}
};

function signalGroup(
	id: number,
	signal: NodeJS.Signals | 0,
	signals: ProcessSignals
): 'signalled' | 'denied' | 'missing' {
	try {
		signals.kill(-id, signal);

		return 'signalled';
	} catch (error) {
		if (isRecord(error) && error.code === 'ESRCH') {
			return 'missing';
		}

		if (isRecord(error) && error.code === 'EPERM') {
			return 'denied';
		}

		throw error;
	}
}

export interface HostProcessRunner {
	readonly run: (
		request: ProcessRequest,
		context: BackendProcessContext
	) => Promise<BackendProcessOutcome>;
}

export class PosixProcessRunner implements HostProcessRunner {
	readonly #workspace: string;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #shells: ReadonlyMap<ShellDialect, string>;
	readonly #signals: ProcessSignals;

	constructor(
		workspace: string,
		environment: NodeJS.ProcessEnv,
		shells: ReadonlyMap<ShellDialect, string>,
		signals: ProcessSignals = nativeSignals
	) {
		this.#workspace = workspace;
		this.#environment = { ...environment };
		this.#shells = new Map(shells);
		this.#signals = signals;
	}

	#command(request: ProcessRequest): {
		executable: string;
		args: readonly string[];
	} {
		if (request.kind === 'argv') {
			return { executable: request.executable, args: request.args };
		}

		const executable = this.#shells.get(request.dialect);

		if (executable === undefined) {
			throw new UnsupportedSandboxCapabilityError({
				operation: 'exec',
				providerId: 'passthrough'
			});
		}

		return {
			executable,
			args:
				request.dialect === 'powershell'
					? [
							'-NoLogo',
							'-NoProfile',
							'-NonInteractive',
							'-Command',
							request.command
						]
					: ['-c', request.command]
		};
	}

	async run(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		if (process.platform === 'win32') {
			throw new UnsupportedSandboxCapabilityError({
				operation: 'exec',
				providerId: 'passthrough'
			});
		}

		const command = this.#command(request);
		const environment = new Map(Object.entries(this.#environment));
		const overrides = Object.entries(request.env ?? {});

		for (const [key, value] of overrides) {
			if (typeof value === 'string') {
				environment.set(key, value);
				continue;
			}

			environment.delete(key);
		}

		const child = spawn(command.executable, command.args, {
			cwd: path.resolve(this.#workspace, request.cwd ?? '.'),
			env: Object.fromEntries(environment),
			detached: true,
			stdio: ['ignore', 'pipe', 'pipe']
		});
		const completion: Completion = { isClosed: false };
		const cancellation: { startedAt?: number } = {};

		const cancel = () => {
			cancellation.startedAt ??= performance.now();

			if (child.pid !== undefined) {
				try {
					signalGroup(child.pid, 'SIGTERM', this.#signals);
				} catch (error) {
					completion.error ??= error;
				}
			}
		};

		for (const [stream, pipe] of [
			['stdout', child.stdout],
			['stderr', child.stderr]
		] as const) {
			pipe.on('data', (data: Buffer) => {
				try {
					context.onOutput({ stream, data });
				} catch (error) {
					completion.error ??= error;
					cancel();
				}
			});
			pipe.on('error', (error) => {
				completion.error ??= error;
				cancel();
			});
		}

		child.on('error', (error) => {
			completion.error = error;
			cancel();
		});
		child.on('close', (code, signal) => {
			completion.isClosed = true;

			if (typeof code === 'number') {
				completion.exit = { kind: 'code', code };

				return;
			}

			if (signal === null) {
				return;
			}

			completion.exit = {
				kind: 'signal',
				signal,
				signalNumber: osConstants.signals[signal]
			};
		});
		context.signal.addEventListener('abort', cancel, { once: true });

		if (context.signal.aborted) {
			cancel();
		}

		try {
			for (;;) {
				const hasGroup =
					child.pid !== undefined &&
					signalGroup(child.pid, 0, this.#signals) !== 'missing';

				if (!hasGroup && completion.isClosed) {
					if (context.signal.aborted) {
						return { kind: 'cancelled', termination: 'confirmed' };
					}

					if (completion.error !== undefined) {
						throw hostError(completion.error, 'exec');
					}

					if (completion.exit === undefined) {
						throw new SandboxOperationError({
							operation: 'exec',
							providerId: 'passthrough'
						});
					}

					return { kind: 'exited', exit: completion.exit };
				}

				if (
					hasGroup &&
					cancellation.startedAt !== undefined &&
					performance.now() - cancellation.startedAt >= 250
				) {
					signalGroup(child.pid, 'SIGKILL', this.#signals);
				}

				await delay(20);
			}
		} finally {
			context.signal.removeEventListener('abort', cancel);
		}
	}
}
