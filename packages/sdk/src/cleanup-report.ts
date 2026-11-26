import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { SandboxCloseReport, SandboxHost } from './contracts.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import {
	appendDisplayEntry,
	notifyDisplay,
	sendDisplayMessage
} from './display-ui.js';

export function formatCleanupReport(report: SandboxCloseReport): DisplayText {
	const lines = [`Cleanup: ${report.confirmed ? 'confirmed' : 'incomplete'}`];

	for (const failure of report.failures) {
		lines.push(`Cleanup error: ${failure.name}: ${failure.message}`);
	}

	for (const recovery of report.recoveries) {
		if (recovery.kind !== 'allocation') {
			continue;
		}

		const expiry =
			recovery.expiresAt === undefined ? '' : `; expires ${recovery.expiresAt}`;

		lines.push(
			`Recovery: ${recovery.id} (lease ${recovery.lease}${expiry})`,
			recovery.instructions
		);
	}

	return joinDisplayLines(lines.map((line) => cleanDisplayText(line)));
}

export function reportCleanup(
	pi: SandboxHost,
	context: ExtensionContext,
	report: SandboxCloseReport
): void {
	if (report.confirmed) {
		return;
	}

	const content = formatCleanupReport(report);

	if (!context.isIdle()) {
		appendDisplayEntry(pi, cleanDisplayText('byos-cleanup'), content);
		notifyDisplay(context, content, 'warning');
	}

	sendDisplayMessage(pi, cleanDisplayText('byos'), content, {
		triggerTurn: false
	});
}
