import { inspectContext } from './context.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxHost
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';

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

	return ensureSandboxService(pi).close(context);
}
