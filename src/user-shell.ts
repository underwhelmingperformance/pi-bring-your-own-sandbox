import type {
	BashOperations,
	ExtensionAPI
} from '@earendil-works/pi-coding-agent';

import type {
	Sandbox,
	SandboxContext,
	SandboxHost,
	ShellDialect
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { UnsupportedSandboxCapabilityError } from './errors.js';
import { SandboxShell } from './sandbox-shell.js';

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

function operations(pi: SandboxHost, context: SandboxContext): BashOperations {
	const shell = new SandboxShell();
	return {
		async exec(command, _cwd, options) {
			const result = await shell.execute(pi, context, {
				command,
				dialect: (sandbox) => selectDialect(pi, context, sandbox),
				...(options.signal !== undefined && { signal: options.signal }),
				...(options.timeout !== undefined && {
					timeoutSeconds: options.timeout
				}),
				onOutput: ({ data }) => {
					options.onData(Buffer.from(data));
				}
			});
			return {
				exitCode:
					result.exit.kind === 'code'
						? result.exit.code
						: 128 + result.exit.signalNumber
			};
		}
	};
}

/**
Routes Pi user-shell commands through the selected sandbox. The event
handler returns operations before acquisition so Pi can install the
per-command abort signal. Acquisition starts inside operations.exec.
*/
export function registerUserShell(pi: ExtensionAPI): void {
	pi.on('user_bash', (_event, context) => ({
		operations: operations(pi, context)
	}));
}
