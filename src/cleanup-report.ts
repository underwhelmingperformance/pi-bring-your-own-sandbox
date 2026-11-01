import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type { SandboxCloseReport, SandboxHost } from './contracts.js';

export function formatCleanupReport(report: SandboxCloseReport): string {
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

	return lines.join('\n');
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
		pi.appendEntry('byos-cleanup', { content });
		context.ui.notify(content, 'warning');
	}

	pi.sendMessage(
		{ customType: 'byos', content, display: true },
		{ triggerTurn: false }
	);
}
