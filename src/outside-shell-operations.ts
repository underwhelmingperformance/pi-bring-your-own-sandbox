import type {
	BashOperations,
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import {
	createLocalBashOperations,
	createLocalPowerShellOperations
} from '@earendil-works/pi-coding-agent';

import { ApprovalDeniedError } from './approval-errors.js';
import type { ShellDialect } from './contracts.js';
import {
	isSandboxError,
	SandboxCancelledError,
	UnconfirmedSandboxTerminationError
} from './errors.js';
import { requestExecutionApproval } from './execution-approval.js';
import { OperationScope } from './lifecycle.js';
import {
	getOutsideSandboxExecutor,
	outsideExecutionLifetime,
	trackOutsideExecution
} from './outside-execution.js';
import { piProcessResult } from './pi-process-result.js';
import { throwShellOperationError } from './pi-shell-operations.js';
import { runtimeSettings } from './runtime-settings.js';
import { settleProcess } from './termination-scope.js';

export function outsideShellOperations(
	pi: ExtensionAPI,
	context: ExtensionContext,
	dialect: ShellDialect,
	justification: string
): BashOperations {
	const settings = pi.getSettings();
	const normal =
		dialect === 'powershell'
			? createLocalPowerShellOperations()
			: createLocalBashOperations(
					settings.shellPath === undefined
						? undefined
						: { shellPath: settings.shellPath }
				);

	return {
		async exec(command, _cwd, options) {
			const scope = new OperationScope(
				{ operation: 'exec' },
				outsideExecutionLifetime(pi),
				{
					...(options.signal !== undefined && { signal: options.signal }),
					...(options.timeout !== undefined && {
						timeoutMs: options.timeout * 1000
					})
				},
				120_000
			);

			return trackOutsideExecution(pi, scope, async () => {
				try {
					const executor = await getOutsideSandboxExecutor(pi, context, {
						signal: scope.context.signal,
						timeoutMs: scope.remainingMs
					});

					scope.setCleanupBudgets(executor.cleanupBudgets);

					const request = {
						kind: 'shell' as const,
						dialect,
						command,
						cwd: executor.destination.workspace.root
					};
					const bound = runtimeSettings(pi);

					if (
						executor.destination.kind === 'normal' &&
						bound.normalExecutor === undefined
					) {
						const environment =
							options.env === undefined
								? undefined
								: Object.freeze({ ...options.env });
						const decision = await requestExecutionApproval(
							pi,
							context,
							{
								process: request,
								destination: executor.destination,
								justification
							},
							{
								signal: scope.context.signal,
								timeoutMs: scope.remainingMs
							}
						);

						scope.check();

						if (decision.kind !== 'allow') {
							throw new ApprovalDeniedError();
						}

						const result = await settleProcess(
							scope,
							normal.exec(command, executor.destination.workspace.root, {
								...options,
								onData: (data) => {
									if (scope.reason === undefined) {
										options.onData(data);
									}
								},
								...(environment !== undefined && { env: environment }),
								signal: scope.context.signal,
								timeout: scope.remainingMs / 1000
							}),
							'none'
						);

						if (result.kind === 'abandoned') {
							throw new UnconfirmedSandboxTerminationError({
								operation: 'exec'
							});
						}

						if (result.kind === 'rejected') {
							throw result.error;
						}

						scope.check('not-guaranteed');

						return result.value;
					}

					const result = await executor.exec(request, {
						justification,
						signal: scope.context.signal,
						timeoutMs: scope.remainingMs,
						maxCaptureBytes: 0,
						onOutput: ({ data }) => {
							options.onData(Buffer.from(data));
						}
					});

					return piProcessResult(result.exit);
				} catch (error) {
					if (
						scope.reason !== undefined &&
						isSandboxError(error, SandboxCancelledError)
					) {
						throwShellOperationError(
							scope.cancellationError(error.completion),
							options.timeout
						);
					}

					throwShellOperationError(error, options.timeout);
				} finally {
					scope.dispose();
				}
			});
		}
	};
}
