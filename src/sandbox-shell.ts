import { getSandbox } from './client.js';
import type {
	ProcessOutput,
	ProcessResult,
	SandboxClient,
	SandboxContext,
	SandboxHost,
	ShellDialect
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxCancelledError,
	SandboxTimeoutError
} from './errors.js';
import { OperationScope } from './lifecycle.js';
import { snapshotProcessRequest } from './process-input.js';

export interface ShellInvocation {
	readonly dialect: ShellDialect;
	readonly command: string;
	readonly timeoutSeconds?: number;
	readonly signal?: AbortSignal;
	readonly onOutput: (output: ProcessOutput) => void;
}

export class SandboxShell {
	readonly #client: Pick<SandboxClient, 'getSandbox'>;

	constructor(client?: Pick<SandboxClient, 'getSandbox'>) {
		this.#client = client ?? { getSandbox };
	}

	async execute(
		pi: SandboxHost,
		context: SandboxContext,
		invocation: ShellInvocation
	): Promise<ProcessResult> {
		const request = snapshotProcessRequest({
			kind: 'shell',
			dialect: invocation.dialect,
			command: invocation.command
		});
		const timeoutMs =
			invocation.timeoutSeconds === undefined
				? undefined
				: invocation.timeoutSeconds * 1000;
		if (
			timeoutMs !== undefined &&
			(!Number.isFinite(timeoutMs) ||
				timeoutMs <= 0 ||
				timeoutMs > 2_147_483_647)
		) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}
		const expiresAt =
			timeoutMs === undefined ? undefined : performance.now() + timeoutMs;
		const scope =
			timeoutMs === undefined
				? undefined
				: new OperationScope(
						{ operation: 'exec' },
						new AbortController().signal,
						invocation.signal === undefined
							? {}
							: { signal: invocation.signal },
						timeoutMs
					);
		const signal = scope?.context.signal ?? invocation.signal;
		try {
			scope?.check();
			checkCaller(signal);
			const sandbox = await this.#client.getSandbox(
				pi,
				context,
				signal === undefined ? {} : { signal }
			);
			const remaining =
				expiresAt === undefined ? undefined : expiresAt - performance.now();
			if (remaining !== undefined && remaining <= 0) {
				scope?.abort('deadline');
			}
			scope?.check();
			checkCaller(signal);
			scope?.dispose();
			return await sandbox.exec(
				{ ...request, cwd: sandbox.workspace.root },
				{
					...(invocation.signal !== undefined && { signal: invocation.signal }),
					...(remaining !== undefined && { timeoutMs: remaining }),
					maxCaptureBytes: 0,
					onOutput: invocation.onOutput
				}
			);
		} catch (error) {
			if (
				scope?.reason === 'deadline' &&
				isSandboxError(error, SandboxCancelledError) &&
				error.reason === 'caller'
			) {
				throw new SandboxTimeoutError(
					{
						operation: 'exec',
						completion: error.completion,
						...(error.providerId !== undefined && {
							providerId: error.providerId
						}),
						...(error.backendId !== undefined && {
							backendId: error.backendId
						}),
						...(error.recovery !== undefined && { recovery: error.recovery })
					},
					{ cause: error }
				);
			}
			throw error;
		} finally {
			scope?.dispose();
		}
	}
}

function checkCaller(signal: AbortSignal | undefined): void {
	if (signal?.aborted === true) {
		throw new SandboxCancelledError({
			operation: 'exec',
			reason: 'caller',
			completion: 'not-started'
		});
	}
}
