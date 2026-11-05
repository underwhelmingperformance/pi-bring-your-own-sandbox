import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import type {
	Sandbox,
	SandboxContext,
	SandboxHost,
	ShellDialect
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { UnsupportedSandboxCapabilityError } from './errors.js';
import { createShellOperations } from './pi-shell-operations.js';

async function selectDialect(
	pi: SandboxHost,
	context: SandboxContext,
	sandbox: Sandbox
): Promise<ShellDialect> {
	const status = await ensureSandboxService(pi).status(context);
	const dialect = status.selection?.userShell ?? sandbox.workspace.defaultShell;

	if (dialect === undefined) {
		throw new UnsupportedSandboxCapabilityError({
			operation: 'exec',
			providerId: sandbox.providerId,
			backendId: sandbox.backendId
		});
	}

	return dialect;
}

/**
Routes Pi user-shell commands through the selected sandbox. The event
handler returns operations before acquisition so Pi can install the
per-command abort signal. Acquisition starts inside operations.exec.
*/
export function registerUserShell(pi: ExtensionAPI): void {
	pi.on('user_bash', (_event, context) => ({
		operations: createShellOperations(pi, context, (sandbox) =>
			selectDialect(pi, context, sandbox)
		)
	}));
}
