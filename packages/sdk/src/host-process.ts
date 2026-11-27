import { spawn } from 'node:child_process';
import { constants as osConstants } from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DEFAULT_CLEANUP_BUDGETS } from './cleanup-budgets.js';
import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessExit,
	ProcessRequest,
	ShellDialect
} from './contracts.js';
import {
	SandboxOperationError,
	UnconfirmedSandboxTerminationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { mapSandboxErrno } from './host-error.js';
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
		if (isRecord(error) && error['code'] === 'ESRCH') {
			return 'missing';
		}

		if (isRecord(error) && error['code'] === 'EPERM') {
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

interface PosixProcessInvocation {
	readonly executable: string;
	readonly args: readonly string[];
	readonly cwd: string;
	readonly env: Readonly<NodeJS.ProcessEnv>;
}

interface PosixProcessRunnerOptions {
	readonly providerId?: string;
	/**
	Wrap the final invocation before starting it in a new process group.
	The wrapper and its workload must stay in that group for cancellation.
	*/
	readonly wrap?: (
		invocation: PosixProcessInvocation
	) => PosixProcessInvocation;
}

/**
Runs POSIX processes and waits for the process group to exit. A provider can
wrap the final invocation with its sandbox command.
*/
export class PosixProcessRunner implements HostProcessRunner {
	readonly #workspace: string;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #shells: ReadonlyMap<ShellDialect, string>;
	readonly #signals: ProcessSignals;
	readonly #options: PosixProcessRunnerOptions;

	constructor(
		workspace: string,
		environment: NodeJS.ProcessEnv,
		shells: ReadonlyMap<ShellDialect, string>,
		options: PosixProcessRunnerOptions = {},
		signals: ProcessSignals = nativeSignals
	) {
		this.#workspace = workspace;
		this.#environment = { ...environment };
		this.#shells = new Map(shells);
		this.#signals = signals;
		this.#options = { ...options };
	}

	#identity() {
		return {
			operation: 'exec' as const,
			...(this.#options.providerId !== undefined && {
				providerId: this.#options.providerId
			})
		};
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
			throw new UnsupportedSandboxCapabilityError(this.#identity());
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
			throw new UnsupportedSandboxCapabilityError(this.#identity());
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

		const invocation = {
			...command,
			cwd: path.resolve(this.#workspace, request.cwd ?? '.'),
			env: Object.fromEntries(environment)
		};
		const wrapped = this.#options.wrap?.(invocation) ?? invocation;
		const child = spawn(wrapped.executable, wrapped.args, {
			cwd: wrapped.cwd,
			env: wrapped.env,
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
						throw mapSandboxErrno(completion.error, this.#identity());
					}

					if (completion.exit === undefined) {
						throw new SandboxOperationError(this.#identity());
					}

					return { kind: 'exited', exit: completion.exit };
				}

				const startedAt = cancellation.startedAt;
				let delayMs = 20;

				if (startedAt !== undefined) {
					const elapsed = performance.now() - startedAt;
					const grace = (context.cleanupBudgets ?? DEFAULT_CLEANUP_BUDGETS)
						.cancellationGraceMs;
					const remaining = context.cleanup.remainingMs() ?? grace - elapsed;

					if (hasGroup && (elapsed >= 250 || remaining <= 0)) {
						signalGroup(child.pid, 'SIGKILL', this.#signals);
					}

					if (remaining <= 0) {
						if (context.signal.aborted) {
							return { kind: 'cancelled', termination: 'unconfirmed' };
						}

						throw new UnconfirmedSandboxTerminationError(this.#identity(), {
							cause: completion.error
						});
					}

					delayMs = Math.min(delayMs, remaining);
				}

				await delay(delayMs);
			}
		} finally {
			context.signal.removeEventListener('abort', cancel);

			if (!completion.isClosed) {
				child.stdout.destroy();
				child.stderr.destroy();
				child.unref();
			}
		}
	}
}
