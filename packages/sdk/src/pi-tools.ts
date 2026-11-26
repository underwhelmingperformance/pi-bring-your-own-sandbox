import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createBashToolDefinition,
	createPowerShellToolDefinition,
	defineTool
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { bindShellIntegration } from './integration/privileged.js';

function shellDefinition(
	pi: ExtensionAPI,
	dialect: 'bash' | 'powershell',
	extensionPath: string,
	integration: ReturnType<typeof bindShellIntegration>
) {
	const create =
		dialect === 'bash'
			? createBashToolDefinition
			: createPowerShellToolDefinition;
	const base = create('/unused', { exposeSessionEnvironment: false });
	const timeout = Type.With(base.parameters.properties.timeout, {
		description:
			'Timeout in seconds for startup and execution. BYOS allows 60 seconds for startup and 120 seconds for execution by default. An escalation decision allows at most 60 seconds.'
	});

	const parameters = Type.Object(
		{
			...base.parameters.properties,
			timeout,
			...integration.escalationParameters
		},
		{ additionalProperties: false }
	);

	const isSelected = () =>
		pi
			.getAllTools()
			.some(
				(tool) =>
					tool.name === dialect &&
					tool.sourceInfo.path === extensionPath &&
					tool.parameters === parameters
			);
	const execute = integration.registerRoute(dialect, isSelected);

	const tool = defineTool({
		...base,
		defaultActive: false,
		parameters,
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			'Shell commands execute in the selected sandbox workspace by default.',
			'Pi full-output paths refer to host transcript files.'
		],
		execute(id, input, signal, update, context) {
			return execute(id, input, context, (prefix, operations) => {
				const tool = create(context.cwd, {
					...(prefix !== undefined && { commandPrefix: prefix }),
					exposeSessionEnvironment: false,
					operations
				});

				return tool.execute(id, input, signal, update, context);
			});
		}
	});

	return { tool, isSelected };
}

/**
Connects Pi's bash, PowerShell and user-shell operation hooks to the selected
sandbox. Load this entry explicitly. Pi retains tool execution and rendering;
file and search tools remain outside this integration's supported paths.
*/
export default function sandboxTools(
	pi: ExtensionAPI,
	extensionPath = import.meta.filename
): void {
	const integration = bindShellIntegration(pi, extensionPath);

	const bash = shellDefinition(pi, 'bash', extensionPath, integration);
	const powershell = shellDefinition(
		pi,
		'powershell',
		extensionPath,
		integration
	);

	pi.registerTool(bash.tool);
	pi.registerTool(powershell.tool);
	integration.complete(
		(name) =>
			(name === 'bash' && bash.isSelected()) ||
			(name === 'powershell' && powershell.isSelected())
	);
}

/**
Keep the selected BYOS Bash tool at session start and before each prompt.
Block direct and nested calls to tools outside that selection. Pass the Pi
extension entry path so an override cannot claim the routed tool.
*/
export function registerShellOnlyTools(
	pi: ExtensionAPI,
	extensionPath: string
): void {
	const integration = bindShellIntegration(pi, extensionPath);

	const bash = shellDefinition(pi, 'bash', extensionPath, integration);

	pi.registerTool(bash.tool);

	const select = () => {
		const selected = pi.getActiveTools();
		const allowed = selected.filter(
			(name) => name === 'bash' && bash.isSelected()
		);

		if (allowed.length !== selected.length) {
			pi.setActiveTools(allowed);
		}
	};

	pi.on('session_start', select);
	pi.on('before_agent_start', select);
	integration.complete((name) => name === 'bash' && bash.isSelected());
	pi.on('tool_call', (event) => {
		if (
			event.toolName === 'bash' &&
			pi.getActiveTools().includes('bash') &&
			bash.isSelected()
		) {
			return;
		}

		return {
			block: true,
			reason:
				'The shell-only profile blocks every tool except the selected BYOS Bash tool.'
		};
	});
}
