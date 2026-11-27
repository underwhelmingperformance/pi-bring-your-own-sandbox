import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';

import { negotiateSandbox } from './client.js';
import type { ShellDialect } from './contracts.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import { isSandboxError } from './errors.js';
import { describeRestrictions } from './escalation-plan.js';
import { accessOrder } from './policy-model.js';
import { shellRequirements } from './profile-negotiation.js';
import { shellSettings } from './runtime-participant.js';
import { isShell } from './validation.js';

const section = 'byos_shell_restrictions';
const escalationGuidance = [
	'Use escalate with a justification to request extra access for one command.',
	`You can request ${accessOrder.join(', ')}, or specific read and write paths.`,
	'BYOS selects the destination before the decision.',
	'The host has no sandbox restrictions.'
].join(' ');

async function describeShellPolicy(
	pi: ExtensionAPI,
	context: ExtensionContext,
	dialect: ShellDialect
): Promise<{ readonly text: DisplayText; readonly allowEscalation?: boolean }> {
	const label = { sh: 'sh', bash: 'Bash', powershell: 'PowerShell' }[dialect];

	try {
		const result = await negotiateSandbox(
			pi,
			context,
			shellRequirements(dialect)
		);

		if (!result.ok) {
			throw result.error;
		}

		const config = await shellSettings(pi).read(context);
		const restrictions = describeRestrictions(result.profile.policy, {
			isUnrestrictedHost: config.isUnrestrictedHost,
			...(config.hostUserDataRoots !== undefined && {
				hostUserDataRoots: config.hostUserDataRoots
			})
		});

		return {
			text: cleanDisplayText(
				`Effective restrictions for ordinary BYOS ${label} commands: ${restrictions}`
			),
			allowEscalation: config.allowEscalation
		};
	} catch (error) {
		if (!isSandboxError(error)) {
			throw error;
		}

		return {
			text: cleanDisplayText(
				`BYOS ${label} execution is unavailable. ${error.message}`
			)
		};
	}
}

export function registerShellSystemPrompt(
	pi: ExtensionAPI,
	isRoutedShell: (name: string) => boolean
): void {
	pi.on('before_agent_start', async ({ systemPromptOptions }, context) => {
		const dialects = systemPromptOptions.selectedTools.filter(
			(name): name is ShellDialect => isShell(name) && isRoutedShell(name)
		);

		if (dialects.length === 0) {
			return;
		}

		const policies = await Promise.all(
			dialects.map((dialect) => describeShellPolicy(pi, context, dialect))
		);
		const lines = policies.map(({ text }) => text);
		const allowsEscalation = policies.find(
			({ allowEscalation }) => allowEscalation !== undefined
		)?.allowEscalation;

		if (allowsEscalation !== undefined) {
			lines.push(
				cleanDisplayText(
					allowsEscalation
						? escalationGuidance
						: 'allowEscalation is false, so BYOS will refuse escalations.'
				)
			);
		}

		const text = joinDisplayLines(lines);

		systemPromptOptions.sections[section] = text;

		const forced = systemPromptOptions.forceSystemPrompt;

		if (forced === undefined) {
			return;
		}

		return {
			systemPrompt: `${forced}\n\n<${section}>\n${text}\n</${section}>`
		};
	});
}
