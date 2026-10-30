import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createBashToolDefinition,
	createPowerShellToolDefinition
} from '@earendil-works/pi-coding-agent';

import { registerShellIntegrationDiagnostics } from './pi-integration-status.js';
import { createShellOperations } from './pi-shell-operations.js';
import { registerUserShell } from './user-shell.js';

function shellDefinition(
	pi: ExtensionAPI,
	dialect: 'bash' | 'powershell'
): ReturnType<typeof createBashToolDefinition> {
	const create =
		dialect === 'bash'
			? createBashToolDefinition
			: createPowerShellToolDefinition;
	const base = create('/unused', { exposeSessionEnvironment: false });
	const timeout = {
		...base.parameters.properties.timeout,
		description:
			'Timeout in seconds for startup and execution. If omitted, startup allows 60 seconds and execution 120 seconds.'
	};
	return {
		...base,
		defaultActive: false,
		parameters: {
			...base.parameters,
			properties: {
				...base.parameters.properties,
				timeout
			}
		},
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			'Shell commands execute in the selected sandbox workspace.',
			'Pi full-output paths refer to host transcript files.'
		],
		execute(id, input, signal, update, context) {
			const prefix =
				dialect === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
			const tool = create(context.cwd, {
				...(prefix !== undefined && { commandPrefix: prefix }),
				exposeSessionEnvironment: false,
				operations: createShellOperations(pi, context, dialect)
			});
			return tool.execute(id, input, signal, update, context);
		}
	};
}

/**
Connects Pi's bash, PowerShell and user-shell operation hooks to the selected
sandbox. Load this entry explicitly. Pi retains tool execution and rendering;
file and search tools remain outside this integration's supported paths.
*/
export default function sandboxTools(pi: ExtensionAPI): void {
	pi.registerTool(shellDefinition(pi, 'bash'));
	pi.registerTool(shellDefinition(pi, 'powershell'));
	registerUserShell(pi);
	registerShellIntegrationDiagnostics(pi.events);
}
