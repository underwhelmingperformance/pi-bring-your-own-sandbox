import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type {
	SandboxCloseReport,
	SandboxErrorContext,
	SandboxHost
} from './contracts.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import {
	appendDisplayEntry,
	notifyDisplay,
	sendDisplayMessage
} from './display-ui.js';
import {
	InvalidSandboxDeclarationError,
	isSandboxCloseReport,
	isSandboxError,
	SandboxCleanupError
} from './errors.js';

const disposalIdentity: SandboxErrorContext = { operation: 'dispose' };

export function failedCloseReport(
	cause: unknown,
	identity: SandboxErrorContext = disposalIdentity
): SandboxCloseReport {
	const failure = isSandboxError(cause)
		? cause
		: new SandboxCleanupError(identity, { cause });
	const report = isSandboxError(failure, SandboxCleanupError)
		? failure.closeReport
		: undefined;

	const recoveries =
		report?.recoveries ??
		(failure.recovery?.kind === 'allocation' ? [failure.recovery] : []);

	return Object.freeze({
		confirmed: false,
		failures: Object.freeze([failure]),
		recoveries: Object.freeze([...recoveries])
	});
}

export async function settleSandboxClose(
	close: () => Promise<SandboxCloseReport>,
	identity?: SandboxErrorContext
): Promise<SandboxCloseReport> {
	try {
		const report = await close();

		if (!isSandboxCloseReport(report)) {
			throw new InvalidSandboxDeclarationError({ operation: 'dispose' });
		}

		return report;
	} catch (error) {
		return failedCloseReport(error, identity);
	}
}

export function formatCleanupReport(report: SandboxCloseReport): DisplayText {
	const lines = [`Cleanup: ${report.confirmed ? 'confirmed' : 'incomplete'}`];

	for (const failure of report.failures) {
		lines.push(`Cleanup error: ${failure.name}: ${failure.message}`);
	}

	for (const recovery of report.recoveries) {
		if (recovery.kind !== 'allocation') {
			continue;
		}

		lines.push(
			`Recovery: ${recovery.id} (lease ${recovery.lease})`,
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
