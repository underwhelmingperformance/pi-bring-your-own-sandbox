import { acquireOptions, checkRequirements } from './acquire-options.js';
import { inspectContext } from './context.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxCopy,
	SandboxCopyOptions,
	SandboxHost
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import {
	isSandboxError,
	SandboxCleanupError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { closeApprovals } from './execution-approval.js';
import { closeOutsideExecution } from './outside-execution.js';
import type { SandboxNegotiation } from './protocol.js';
import { runtimeSettings } from './runtime-settings.js';
import { copyOptions, rethrowCopyError } from './sandbox-copy.js';

/**
Acquire the selected sandbox from a live Pi event, command or tool context.
Call after extension loading. All consumers share the user's provider selection;
an unconfigured user gets the host backend. A requested policy can tighten the
user's policy but not loosen it, and consumers that request the same policy
share one backend. Configured failures never select host execution. Cancelling
an acquisition leaves shared startup running.
*/
export async function getSandbox(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxAcquireOptions
): Promise<Sandbox> {
	inspectContext(context, 'acquire');

	const settings = acquireOptions(options);
	const sandbox = await ensureSandboxService(pi).acquire(context, settings);

	checkRequirements(sandbox, settings);

	return sandbox;
}

/**
Copy the host workspace into a private sandbox from the selected provider. The
broker opens the strictest policy that satisfies the options and the session's
configured access. Close the copy when it is no longer needed. Use
`sandbox.copy` instead to copy a sandbox whose files can differ from the host.
*/
export async function copyHostWorkspace(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxCopyOptions
): Promise<SandboxCopy> {
	inspectContext(context, 'acquire');

	const settings = copyOptions(options);
	const broker = ensureSandboxService(pi);

	if (broker.copy === undefined) {
		throw new UnsupportedSandboxCapabilityError({ operation: 'acquire' });
	}

	const copy = await broker.copy(context, { kind: 'host' }, settings);

	try {
		checkRequirements(copy.sandbox, {
			...settings,
			workspaceRelationship: 'copied'
		});

		return copy;
	} catch (error) {
		rethrowCopyError(error, await copy.close(), {
			operation: 'dispose',
			providerId: copy.sandbox.providerId,
			backendId: copy.sandbox.backendId
		});
	}
}

/**
Check whether `getSandbox` with the same options could succeed, without
provisioning a backend. Returns the policy that acquisition would open, or the
typed error that it would throw. An opened backend can still advertise fewer
capabilities than its provider declares, so acquisition validates it again.
*/
export async function negotiateSandbox(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxAcquireOptions
): Promise<SandboxNegotiation> {
	inspectContext(context, 'acquire');

	return ensureSandboxService(pi).negotiate(context, options);
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
