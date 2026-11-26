import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';

import { negotiateSandbox } from './client.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import { isSandboxError } from './errors.js';
import { describeRestrictions } from './escalation-plan.js';
import { passthroughProvider } from './passthrough-provider.js';
import { accessOrder } from './policy-model.js';
import { runtimeSettings } from './runtime-settings.js';

const section = 'byos_shell_restrictions';
const escalationGuidance = [
	'Use escalate with a justification to request extra access for one command.',
	`You can request ${accessOrder.join(', ')}, or specific read and write paths.`,
	'BYOS selects the destination before the decision.',
	'The host has no sandbox restrictions.'
].join(' ');

async function describeShellPolicy(
	pi: ExtensionAPI,
	context: ExtensionContext
): Promise<DisplayText> {
	try {
		const result = await negotiateSandbox(pi, context);

		if (!result.ok) {
			throw result.error;
		}

		const config = await runtimeSettings(pi).read(context);
		const restrictions = describeRestrictions(
			result.profile.policy,
			undefined,
			config.selection.providerId === passthroughProvider.id
		);
		const escalation =
			config.allowEscalation === false
				? 'allowEscalation is false, so BYOS will refuse escalations.'
				: escalationGuidance;

		return joinDisplayLines([
			cleanDisplayText(
				`Effective restrictions for ordinary BYOS shell commands: ${restrictions}`
			),
			cleanDisplayText(escalation)
		]);
	} catch (error) {
		if (!isSandboxError(error)) {
			throw error;
		}

		return cleanDisplayText(
			`BYOS shell execution is unavailable. ${error.message}`
		);
	}
}

export function registerShellSystemPrompt(
	pi: ExtensionAPI,
	isRoutedShell: (name: string) => boolean
): void {
	pi.on('before_agent_start', async ({ systemPromptOptions }, context) => {
		if (
			systemPromptOptions.selectedTools.every((name) => !isRoutedShell(name))
		) {
			return;
		}

		const text = await describeShellPolicy(pi, context);

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
