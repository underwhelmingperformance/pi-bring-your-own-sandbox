import type { SandboxCloseReport } from './contracts.js';

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
