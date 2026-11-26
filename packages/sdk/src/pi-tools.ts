import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	createBashToolDefinition,
	createPowerShellToolDefinition,
	defineTool
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { InvalidApprovalRequestError } from './approval-errors.js';
import { reportCleanup } from './cleanup-report.js';
import { bindFactory } from './default-broker.js';
import { cleanDisplayText } from './display-text.js';
import { InvalidSandboxRequestError } from './errors.js';
import type { EscalatedSandbox } from './escalation-plan.js';
import { describeRestrictions } from './escalation-plan.js';
import { outsideShellOperations } from './outside-shell-operations.js';
import { registerShellIntegrationDiagnostics } from './pi-integration-status.js';
import { createShellOperations } from './pi-shell-operations.js';
import {
	effectiveCommand,
	escalationInput,
	escalationJustificationSchema,
	escalationListSchema,
	PendingEscalation
} from './shell-escalation.js';
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
			escalate: Type.Optional(
				Type.With(escalationListSchema, {
					description:
						'Request extra access for this command. List access properties or specific read and write paths.'
				})
			),
			justification: Type.Optional(
				Type.With(escalationJustificationSchema, {
					description:
						'Reason for the requested access. Required when requesting escalation.'
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
			'To request extra access for a single command, supply escalate and a justification. BYOS selects the destination and asks for a decision.',
			'Pi full-output paths refer to host transcript files.'
		],
		async execute(id, input, signal, update, context) {
			const isOutside = input.execution === 'outside-sandbox';
			const prefix =
				dialect === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
			const requested = escalationInput(
				id,
				effectiveCommand(input.command, prefix),
				input
			);
			let escalation = reviews.escalation(id);

			if (
				(requested === undefined && escalation !== undefined) ||
				(requested !== undefined && isOutside)
			) {
				throw new InvalidSandboxRequestError({ operation: 'exec' });
			}

			const reviewed =
				requested === undefined
					? reviews.executing(id, input.command, prefix, isOutside)
					: undefined;

			if (isOutside && input.justification === undefined) {
				throw new InvalidApprovalRequestError();
			}

			if (
				!isOutside &&
				requested === undefined &&
				input.justification !== undefined
			) {
				throw new InvalidApprovalRequestError();
			}

			if (requested !== undefined) {
				if (escalation === undefined) {
					escalation = new PendingEscalation(pi, context, requested);
					await escalation.prepare(dialect);
				}

				escalation.verify(context, requested);
			}

			const pending = escalation;
			const feedback: { type: 'text'; text: string }[] = [];
			let allocation: EscalatedSandbox | undefined;
			const operations = createShellOperations(pi, context, dialect, {
				toolCallId: id,
				...(pending !== undefined && {
					getSandbox: async (command, options) => {
						allocation = await pending.open(context, command, options ?? {});

						return allocation.sandbox;
					}
				}),
				...(reviewed?.kind === 'sandbox' && {
					getSandbox: () => Promise.resolve(reviewed.sandbox)
				}),
				onSandbox: (sandbox) => {
					const paths = sandbox.grantedPaths;
					const restrictions =
						sandbox.providerId === 'passthrough'
							? 'none'
							: describeRestrictions(
									sandbox.policy,
									paths === undefined
										? undefined
										: {
												read: paths
													.filter((grant) => grant.kind === 'read')
													.map((grant) => grant.targetPath),
												write: paths
													.filter((grant) => grant.kind === 'write')
													.map((grant) => grant.targetPath)
											}
								);

					feedback.push({
						type: 'text',
						text: cleanDisplayText('Effective restrictions: ' + restrictions)
					});
				},
				onResult: (result) => {
					const violations = result.violations ?? [];

					for (const violation of violations) {
						const target =
							violation.resource === undefined
								? ''
								: ' on ' + violation.resource;
						const text = `Restriction violation: ${violation.operation} (${violation.accessProperty})${target}`;

						feedback.push({ type: 'text', text: cleanDisplayText(text) });
					}
				}
			});
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
						: operations
			});

			try {
				const result = await tool.execute(id, input, signal, update, context);

				return feedback.length === 0
					? result
					: { ...result, content: [...result.content, ...feedback] };
			} finally {
				pending?.finish();

				if (allocation !== undefined) {
					reportCleanup(pi, context, await allocation.close());
				}
			}
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
	bindFactory(pi, extensionPath);
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
	bindFactory(pi, extensionPath);

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
