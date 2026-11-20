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

function shellDefinition(pi: ExtensionAPI, dialect: 'bash' | 'powershell') {
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

	const reviews = new ShellReviewRoutes(pi, dialect, parameters);

	return defineTool({
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
			const reviewed = reviews.executing(id, input.command, isOutside);

			if (isOutside && input.justification === undefined) {
				throw new InvalidApprovalRequestError();
			}

			if (!isOutside && input.justification !== undefined) {
				throw new InvalidApprovalRequestError();
			}

			const prefix =
				dialect === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
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

/**
Expose the routed Bash tool when Pi's loadout selects it. Check each call
because Pi can invoke deferred tools indirectly after they leave the loadout.
*/
export function registerShellOnlyTools(pi: ExtensionAPI): void {
	const bash = shellDefinition(pi, 'bash');

	pi.registerTool(bash);
	registerUserShell(pi);
	registerShellIntegrationDiagnostics(pi.events);

	const isRegisteredBash = () =>
		pi
			.getAllTools()
			.some(
				(tool) => tool.name === 'bash' && tool.parameters === bash.parameters
			);
	const select = () => {
		const selected = pi.getActiveTools();
		const allowed = selected.filter(
			(name) => name === 'bash' && isRegisteredBash()
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
			isRegisteredBash()
		) {
			return;
		}

		return {
			block: true,
			reason:
				'The shell-only profile permits calls to the selected BYOS Bash tool.'
		};
	});
}
