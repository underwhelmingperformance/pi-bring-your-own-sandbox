import { inspectContext } from './context.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxHost
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { isSandboxError, SandboxCleanupError } from './errors.js';
import { closeApprovals } from './execution-approval.js';
import { closeOutsideExecution } from './outside-execution.js';
import { runtimeSettings } from './runtime-settings.js';

/**
Acquire the selected sandbox from a live Pi event, command or tool context.
Call after extension loading. All consumers share the user's provider selection;
an unconfigured user gets the host backend. Configured failures never select
host execution. Cancelling an acquisition leaves shared startup running.
*/
export async function getSandbox(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxAcquireOptions
): Promise<Sandbox> {
	inspectContext(context, 'acquire');

	return ensureSandboxService(pi).acquire(context, options);
}

/**
Close the shared generation before an embedding host disposes a raw Pi
session. Repeated calls return the same cleanup report. Pi's session runtime
performs this shutdown through lifecycle handlers.
*/
export async function closeSandboxSession(
	pi: SandboxHost,
	context: SandboxContext
): Promise<SandboxCloseReport> {
	inspectContext(context, 'dispose');

	const closures: readonly (() =>
		readonly SandboxCloseReport[] | Promise<readonly SandboxCloseReport[]>)[] =
		[
			() => {
				runtimeSettings(pi).close();

				return [];
			},
			() => {
				closeApprovals(pi);

				return [];
			},
			async () => [await ensureSandboxService(pi).close(context)],
			() => closeOutsideExecution(pi, context)
		];
	const settlements = await Promise.allSettled(
		closures.map((close) => Promise.try(close))
	);
	const reports = settlements.flatMap(
		(result): readonly SandboxCloseReport[] => {
			if (result.status === 'fulfilled') {
				return result.value;
			}

			return [
				{
					confirmed: false,
					recoveries: [],
					failures: [
						isSandboxError(result.reason)
							? result.reason
							: new SandboxCleanupError(
									{ operation: 'dispose' },
									{ cause: result.reason }
								)
					]
				}
			];
		}
	);

	return Object.freeze({
		confirmed: reports.every((report) => report.confirmed),
		failures: Object.freeze(reports.flatMap((report) => report.failures)),
		recoveries: Object.freeze(reports.flatMap((report) => report.recoveries))
	});
}
