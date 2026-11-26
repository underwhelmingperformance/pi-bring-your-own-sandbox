import type {
	BashOperations,
	createBashToolDefinition,
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { reportCleanup } from '../cleanup-report.js';
import type { ProcessExit } from '../contracts.js';
import { bindFactory } from '../default-broker.js';
import { cleanDisplayText } from '../display-text.js';
import { InvalidSandboxRequestError } from '../errors.js';
import type { EscalatedSandbox } from '../escalation-plan.js';
import { describeRestrictions } from '../escalation-plan.js';
import { passthroughProvider } from '../passthrough-provider.js';
import { registerShellIntegrationDiagnostics } from '../pi-integration-status.js';
import { createShellOperations } from '../pi-shell-operations.js';
import {
	effectiveCommand,
	escalationInput,
	escalationJustificationSchema,
	escalationListSchema,
	PendingEscalation
} from '../shell-escalation.js';
import { ShellReviewRoutes } from '../shell-review-routes.js';
import { registerShellSystemPrompt } from '../shell-system-prompt.js';
import { registerUserShell } from '../user-shell.js';

type Dialect = 'bash' | 'powershell';

interface ShellInput {
	readonly command: string;
	readonly escalate?: unknown;
	readonly justification?: unknown;
}

type ShellExecutor = (
	prefix: string | undefined,
	operations: BashOperations
) => ReturnType<ReturnType<typeof createBashToolDefinition>['execute']>;

const escalationParameters = {
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
};

async function verifyPendingCall(
	pi: ExtensionAPI,
	dialect: Dialect,
	reviews: ShellReviewRoutes,
	id: string,
	input: ShellInput,
	context: ExtensionContext,
	run: ShellExecutor
): ReturnType<ShellExecutor> {
	const prefix =
		dialect === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
	const requested = escalationInput(
		id,
		effectiveCommand(input.command, prefix),
		input
	);
	let escalation = reviews.escalation(id);

	if (requested === undefined && escalation !== undefined) {
		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}

	if (requested === undefined) {
		reviews.verifyExecution(id, input.command, prefix);
	}

	if (requested === undefined && input.justification !== undefined) {
		throw new InvalidSandboxRequestError({
			operation: 'exec',
			detail: { kind: 'request', field: 'justification' }
		});
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
	const execution: { exit?: ProcessExit } = {};
	let allocation: EscalatedSandbox | undefined;
	const operations = createShellOperations(pi, context, dialect, {
		toolCallId: id,
		...(pending !== undefined && {
			getSandbox: async (command, options) => {
				allocation = await pending.open(context, command, options ?? {});

				return allocation.sandbox;
			}
		}),
		onSandbox: (sandbox) => {
			const paths = sandbox.grantedPaths;
			const restrictions = describeRestrictions(
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
						},
				sandbox.providerId === passthroughProvider.id
			);

			feedback.push({
				type: 'text',
				text: cleanDisplayText('Effective restrictions: ' + restrictions)
			});
		},
		onResult: (result) => {
			execution.exit = result.exit;

			const violations = result.violations ?? [];

			for (const violation of violations) {
				const target =
					violation.resource === undefined ? '' : ' on ' + violation.resource;
				const text = `Restriction violation: ${violation.operation} (${violation.accessProperty})${target}`;

				feedback.push({ type: 'text', text: cleanDisplayText(text) });
			}
		}
	});

	try {
		const result = await run(prefix, operations);

		return feedback.length === 0
			? result
			: { ...result, content: [...result.content, ...feedback] };
	} catch (error) {
		if (execution.exit?.kind !== 'unavailable' || !(error instanceof Error)) {
			throw error;
		}

		return {
			isError: true,
			details: undefined,
			content: [{ type: 'text', text: error.message }, ...feedback]
		};
	} finally {
		pending?.finish();

		if (allocation !== undefined) {
			reportCleanup(pi, context, await allocation.close());
		}
	}
}

export function bindShellIntegration(pi: ExtensionAPI, extensionPath: string) {
	bindFactory(pi, extensionPath);

	return {
		escalationParameters,
		registerRoute(dialect: Dialect, isSelected: () => boolean) {
			const reviews = new ShellReviewRoutes(pi, dialect, isSelected);

			return (
				id: string,
				input: ShellInput,
				context: ExtensionContext,
				run: ShellExecutor
			) => verifyPendingCall(pi, dialect, reviews, id, input, context, run);
		},
		complete(isRoutedShell: (name: string) => boolean) {
			registerShellSystemPrompt(pi, isRoutedShell);
			registerUserShell(pi);
			registerShellIntegrationDiagnostics(pi.events);
		}
	};
}
