import type { BashOperations } from '@earendil-works/pi-coding-agent';

import type { Sandbox, SandboxContext, SandboxHost } from './contracts.js';
import {
	isSandboxError,
	SandboxCancelledError,
	SandboxTimeoutError
} from './errors.js';
import { piProcessResult } from './pi-process-result.js';
import { PiShellOutput } from './pi-shell-output.js';
import { DEFAULT_EXEC_TIMEOUT_MS } from './process-input.js';
import type { ShellInvocation } from './sandbox-shell.js';
import { SandboxShell } from './sandbox-shell.js';

/**
Supplies Pi's shell-operation interface with streamed bytes and the exit status
from the selected backend. Pi owns output accumulation and tool presentation.
*/
export function createShellOperations(
	pi: SandboxHost,
	context: SandboxContext,
	dialect: ShellInvocation['dialect'],
	reviewed?: Sandbox
): BashOperations {
	const shell = new SandboxShell(
		reviewed === undefined
			? undefined
			: { getSandbox: () => Promise.resolve(reviewed) }
	);

	return {
		async exec(command, _cwd, options) {
			const output = new PiShellOutput((data) => {
				options.onData(data);
			});

			try {
				const result = await shell.execute(pi, context, {
					command,
					dialect,
					...(options.signal !== undefined && { signal: options.signal }),
					...(options.timeout !== undefined && {
						timeoutSeconds: options.timeout
					}),
					onOutput: ({ data }) => {
						output.write(data);
					}
				});

				return piProcessResult(result.exit);
			} catch (error) {
				throwShellOperationError(error, options.timeout);
			} finally {
				output.flush();
			}
		}
	};
}

export function throwShellOperationError(
	error: unknown,
	timeoutSeconds?: number
): never {
	// Pi retains captured output only for these exact error messages.
	if (
		isSandboxError(error, SandboxCancelledError) &&
		error.completion !== 'unknown'
	) {
		throw new Error('aborted', { cause: error });
	}

	if (
		isSandboxError(error, SandboxTimeoutError) &&
		error.completion !== 'unknown'
	) {
		throw new Error(
			`timeout:${String(timeoutSeconds ?? DEFAULT_EXEC_TIMEOUT_MS / 1000)}`,
			{ cause: error }
		);
	}

	throw error;
}
