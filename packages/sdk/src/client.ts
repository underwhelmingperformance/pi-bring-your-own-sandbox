import { acquireOptions, checkRequirements } from './acquire-options.js';
import { failedCloseReport } from './cleanup-report.js';
import { inspectContext } from './context.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxClient,
	SandboxCloseReport,
	SandboxContext,
	SandboxCopy,
	SandboxCopyOptions,
	SandboxErrorInfo,
	SandboxHost
} from './contracts.js';
import { bindFactory, ensureSandboxService } from './default-broker.js';
import {
	isSandboxError,
	rehydrateSandboxError,
	SandboxInitialisationError
} from './errors.js';
import { closeApprovals } from './execution-approval.js';
import { closeOutsideExecution } from './outside-execution.js';
import type { SandboxNegotiation } from './protocol.js';
import { isPiBound, protocolAddress } from './protocol-address.js';
import { findShellReviewSource, hasShellReviewRoute } from './review-route.js';
import { runtimeSettings } from './runtime-settings.js';
import {
	checkCopiedSandbox,
	copyOptions,
	rethrowCopyError
} from './sandbox-copy.js';

function identifyRequester(
	error: SandboxErrorInfo,
	extensionSource: string
): SandboxErrorInfo {
	if (error.extensionSource !== undefined || error.detail === undefined) {
		return error;
	}

	const {
		operation,
		configurationSource,
		providerId,
		backendId,
		recovery,
		detail
	} = error;

	return rehydrateSandboxError(
		error,
		{ cause: error.cause },
		{
			operation,
			extensionSource,
			detail,
			...(configurationSource !== undefined && { configurationSource }),
			...(providerId !== undefined && { providerId }),
			...(backendId !== undefined && { backendId }),
			...(recovery !== undefined && { recovery })
		}
	);
}

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

	const source = protocolAddress(pi.events).extensionSource;
	const settings = acquireOptions(options, source);

	try {
		const sandbox = await ensureSandboxService(pi).acquire(context, settings);

		checkRequirements(sandbox, settings, source);

		return sandbox;
	} catch (error) {
		throw isSandboxError(error) ? identifyRequester(error, source) : error;
	}
}

/**
Copy the host workspace into a private sandbox from the selected provider. The
broker ranks profiles within the session's
configured access. Close the copy when it is no longer needed. Use
`sandbox.copy` instead to copy a sandbox whose files can differ from the host.
*/
export async function copyHostWorkspace(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxCopyOptions
): Promise<SandboxCopy> {
	inspectContext(context, 'acquire');

	const source = protocolAddress(pi.events).extensionSource;
	const settings = copyOptions(options, source);
	const broker = ensureSandboxService(pi);
	let copy: SandboxCopy;

	try {
		copy = await broker.copy(context, { kind: 'host' }, settings);
	} catch (error) {
		throw isSandboxError(error) ? identifyRequester(error, source) : error;
	}

	try {
		checkCopiedSandbox(copy.sandbox, settings, source);

		return copy;
	} catch (error) {
		return rethrowCopyError(error, () => copy.close(), {
			operation: 'dispose',
			providerId: copy.sandbox.providerId,
			backendId: copy.sandbox.backendId
		});
	}
}

/**
Check whether `getSandbox` with the same options could succeed, without
provisioning a backend. Returns the profile for acquisition, or a typed refusal. Acquisition validates the
opened backend against the selected profile.
*/
export async function negotiateSandbox(
	pi: SandboxHost,
	context: SandboxContext,
	options?: SandboxAcquireOptions
): Promise<SandboxNegotiation> {
	inspectContext(context, 'acquire');

	const source = protocolAddress(pi.events).extensionSource;
	const result = await ensureSandboxService(pi).negotiate(
		context,
		acquireOptions(options, source)
	);

	return result.ok
		? result
		: { ok: false, error: identifyRequester(result.error, source) };
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
			return result.status === 'fulfilled'
				? result.value
				: [failedCloseReport(result.reason)];
		}
	);

	return Object.freeze({
		confirmed: reports.every((report) => report.confirmed),
		failures: Object.freeze(reports.flatMap((report) => report.failures)),
		recoveries: Object.freeze(reports.flatMap((report) => report.recoveries))
	});
}

/**
Register a consumer during its Pi extension factory. The client records the
extension source for discovery and review.
*/
export function createSandboxClient(
	pi: SandboxHost,
	extensionSource: string
): SandboxClient {
	if (isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	bindFactory(pi, extensionSource);

	return Object.freeze<SandboxClient>({
		get: (context, options) => getSandbox(pi, context, options),
		negotiate: (context, options) => negotiateSandbox(pi, context, options),
		hasShellReviewRoute: () => hasShellReviewRoute(pi),
		findShellReviewSource: (context, call) =>
			findShellReviewSource(pi, context, call)
	});
}
