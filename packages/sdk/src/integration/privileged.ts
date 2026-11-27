import type {
	BashOperations,
	createBashToolDefinition,
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { reportCleanup } from '../cleanup-report.js';
import { bindFactory } from '../default-broker.js';
import { cleanDisplayText } from '../display-text.js';
import {
	InvalidSandboxDeclarationError,
	SandboxInitialisationError
} from '../errors.js';
import type { EscalatedSandbox } from '../escalation-plan.js';
import { describeRestrictions } from '../escalation-plan.js';
import { passthroughProvider } from '../passthrough-provider.js';
import { registerShellIntegrationDiagnostics } from '../pi-integration-status.js';
import { createShellOperations } from '../pi-shell-operations.js';
import { protocolAddress } from '../protocol-address.js';
import type { ShellSettings } from '../runtime-participant.js';
import { localRuntimeBindings, shellSettings } from '../runtime-participant.js';
import { shellDispatchSchema } from '../runtime-wire-schemas.js';
import { checker } from '../schemas.js';
import {
	escalationJustificationSchema,
	escalationListSchema
} from '../shell-escalation.js';
import type { ClaimShellCall } from '../shell-review-routes.js';
import { registerShellSystemPrompt } from '../shell-system-prompt.js';
import { registerUserShell } from '../user-shell.js';

const isShellDispatch = checker(shellDispatchSchema);

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
	claim: ClaimShellCall,
	id: string,
	input: ShellInput,
	context: ExtensionContext,
	run: ShellExecutor
): ReturnType<ShellExecutor> {
	const dispatch = claim(id, input, context);

	if (!isShellDispatch(dispatch)) {
		throw new InvalidSandboxDeclarationError({ operation: 'exec' });
	}

	const feedback: { type: 'text'; text: string }[] = [];
	let allocation: EscalatedSandbox | undefined;
	let hostUserDataRoots: readonly string[] = [];
	const open = dispatch.open;
	const operations = createShellOperations(pi, context, dialect, {
		...(open !== undefined && {
			getSandbox: async (command, options) => {
				allocation = await open(command, options ?? {});

				return allocation.sandbox;
			}
		}),
		onSandbox: (sandbox) => {
			const paths = sandbox.grantedPaths;
			const restrictions = describeRestrictions(sandbox.profile.policy, {
				...(paths !== undefined && {
					paths: {
						read: paths
							.filter((grant) => grant.kind === 'read')
							.map((grant) => grant.targetPath),
						write: paths
							.filter((grant) => grant.kind === 'write')
							.map((grant) => grant.targetPath)
					}
				}),
				hostUserDataRoots,
				isUnrestrictedHost: sandbox.providerId === passthroughProvider.id
			});

			feedback.push({
				type: 'text',
				text: cleanDisplayText('Effective restrictions: ' + restrictions)
			});
		}
	});

	try {
		const settings = await shellSettings(pi).read(context);

		hostUserDataRoots = settings.hostUserDataRoots ?? [];

		const result = await run(dispatch.prefix, operations);

		return feedback.length === 0
			? result
			: { ...result, content: [...result.content, ...feedback] };
	} catch (error) {
		if (feedback.length === 0 || !(error instanceof Error)) {
			throw error;
		}

		return {
			isError: true,
			details: undefined,
			content: [{ type: 'text', text: error.message }, ...feedback]
		};
	} finally {
		dispatch.finish();

		if (allocation !== undefined) {
			reportCleanup(pi, context, await allocation.close());
		}
	}
}

export function bindShellIntegration(pi: ExtensionAPI, extensionPath: string) {
	bindFactory(pi, extensionPath);

	const bindings = localRuntimeBindings(pi);

	return {
		escalationParameters,
		registerRoute(dialect: Dialect, parameters: TSchema) {
			let claim: ClaimShellCall | undefined;

			bindings.shellRoutes.push(
				Object.freeze({
					pi,
					toolName: dialect,
					identity: protocolAddress(pi.events),
					parameters,
					receive(connected: ClaimShellCall, settings: ShellSettings) {
						claim = connected;
						bindings.shellSettings = settings;
					}
				})
			);

			return (
				id: string,
				input: ShellInput,
				context: ExtensionContext,
				run: ShellExecutor
			) => {
				if (claim === undefined) {
					throw new SandboxInitialisationError({ operation: 'exec' });
				}

				return verifyPendingCall(pi, dialect, claim, id, input, context, run);
			};
		},
		complete(isRoutedShell: (name: string) => boolean) {
			registerShellSystemPrompt(pi, isRoutedShell);
			registerUserShell(pi);
			registerShellIntegrationDiagnostics(pi.events);
		}
	};
}
