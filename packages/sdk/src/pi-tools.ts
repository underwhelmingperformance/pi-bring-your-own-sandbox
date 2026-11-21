import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createBashToolDefinition,
	createPowerShellToolDefinition,
	defineTool
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { InvalidApprovalRequestError } from './approval-errors.js';
import { justificationSchema } from './approval-schemas.js';
import { outsideShellOperations } from './outside-shell-operations.js';
import { registerShellIntegrationDiagnostics } from './pi-integration-status.js';
import { createShellOperations } from './pi-shell-operations.js';
import { ShellReviewRoutes } from './shell-review-routes.js';
import { registerUserShell } from './user-shell.js';

function shellDefinition(
	pi: ExtensionAPI,
	dialect: 'bash' | 'powershell',
	extensionPath: string
) {
	const create =
		dialect === 'bash'
			? createBashToolDefinition
			: createPowerShellToolDefinition;
	const base = create('/unused', { exposeSessionEnvironment: false });
	const timeout = Type.With(base.parameters.properties.timeout, {
		description:
			'Timeout in seconds for startup and execution. Sandboxed execution allows 60 seconds for startup and 120 seconds for execution by default. Outside execution defaults to 120 seconds including approval; approval allows at most 60 seconds.'
	});

	const parameters = Type.Object(
		{
			...base.parameters.properties,
			timeout,
			execution: Type.Optional(
				Type.Enum(['sandbox', 'outside-sandbox'], {
					description:
						'Use outside-sandbox to request approved execution on the configured outside destination.'
				})
			),
			justification: Type.Optional(
				Type.With(justificationSchema, {
					description:
						'Reason for execution outside the sandbox; required with execution outside-sandbox.'
				})
			)
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
	const reviews = new ShellReviewRoutes(pi, dialect, isSelected);

	const tool = defineTool({
		...base,
		defaultActive: false,
		parameters,
		promptGuidelines: [
			...(base.promptGuidelines ?? []),
			'Shell commands execute in the selected sandbox workspace by default.',
			'To request execution outside the sandbox, specify execution: outside-sandbox and a justification. Requests use the selected approval policy and execution destination.',
			'Pi full-output paths refer to host transcript files.'
		],
		async execute(id, input, signal, update, context) {
			const isOutside = input.execution === 'outside-sandbox';
			const prefix =
				dialect === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
			const reviewed = reviews.executing(id, input.command, prefix, isOutside);

			if (isOutside && input.justification === undefined) {
				throw new InvalidApprovalRequestError();
			}

			if (!isOutside && input.justification !== undefined) {
				throw new InvalidApprovalRequestError();
			}

			const tool = create(context.cwd, {
				...(prefix !== undefined && { commandPrefix: prefix }),
				exposeSessionEnvironment: isOutside,
				operations:
					isOutside && input.justification !== undefined
						? outsideShellOperations(
								pi,
								context,
								dialect,
								input.justification,
								reviewed?.kind === 'host'
							)
						: createShellOperations(
								pi,
								context,
								dialect,
								reviewed?.kind === 'sandbox' ? reviewed.sandbox : undefined
							)
			});

			return tool.execute(id, input, signal, update, context);
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
	pi.registerTool(shellDefinition(pi, 'bash', extensionPath).tool);
	pi.registerTool(shellDefinition(pi, 'powershell', extensionPath).tool);
	registerUserShell(pi);
	registerShellIntegrationDiagnostics(pi.events);
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
	const bash = shellDefinition(pi, 'bash', extensionPath);

	pi.registerTool(bash.tool);
	registerUserShell(pi);
	registerShellIntegrationDiagnostics(pi.events);

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
