import { formatCleanupReport } from './cleanup-report.js';
import type { SandboxPolicy } from './contracts.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import { policyKey } from './negotiation.js';
import type { ProviderInfo, SandboxStatus } from './protocol.js';

function list(values: readonly string[]): string {
	return values.length === 0 ? 'none' : values.join(', ');
}

function quoted(value: string): string {
	return JSON.stringify(value).replaceAll(
		/[\p{Control}\p{Format}\p{Line_Separator}\p{Paragraph_Separator}]/gu,
		(character) =>
			character
				.split('')
				.map(
					(unit) =>
						'\\u' + (unit.codePointAt(0) ?? 0).toString(16).padStart(4, '0')
				)
				.join('')
	);
}

function policy(
	value: SandboxPolicy,
	workspaceRelationship = value.workspaceRelationship
): string {
	const relationship =
		workspaceRelationship === undefined ? '' : ` (${workspaceRelationship})`;

	const protectedResources = (value.workspaceProtection ?? []).map(
		(resource) =>
			resource.kind === 'git-metadata' ? 'Git metadata' : quoted(resource.path)
	);

	return `workspace ${value.workspaceAccess}${relationship}; filesystem ${value.filesystemScope}; network ${value.networkAccess}; protected resources: ${list(protectedResources)}`;
}

function userShell(status: SandboxStatus): string {
	const configured = status.selection?.userShell;

	if (configured !== undefined) {
		return status.capabilities === undefined ||
			status.capabilities.shells.includes(configured)
			? `${configured} (configured)`
			: `${configured} (configured; unavailable on this backend)`;
	}

	return status.workspace === undefined
		? 'provider default (not opened)'
		: (status.workspace.defaultShell ?? 'unavailable');
}

export function formatStatus(status: SandboxStatus): DisplayText {
	const selection = status.selection;
	const baseKey =
		selection === undefined ? undefined : policyKey(selection.policy);
	const additional = (status.backends ?? []).filter(
		(backend) => policyKey(backend.policy) !== baseKey
	);
	const lines = [
		selection === undefined
			? 'Provider: unavailable'
			: `Provider: ${selection.providerId} (${selection.source})`,
		`State: ${status.state}`,
		`Generation: ${status.generationId}`
	];

	if (status.backendId !== undefined) {
		lines.push(`Backend: ${status.backendId}`);
	}

	lines.push(
		status.workspace === undefined
			? additional.length === 0
				? 'Target: not opened'
				: 'Default target: not opened'
			: `Target: ${status.workspace.root} (${status.workspace.relationship})`
	);

	if (status.policy !== undefined) {
		lines.push(
			`Effective policy: ${policy(status.policy, status.workspace?.relationship)}`
		);
	}

	if (selection !== undefined && status.policy === undefined) {
		lines.push(`Requested policy: ${policy(selection.policy)}`);
	}

	if (status.capabilities !== undefined) {
		lines.push(
			`Operations: ${list(status.capabilities.operations)}`,
			`Termination scope: ${status.capabilities.terminationScope}`,
			`Shells: ${list(status.capabilities.shells)}`
		);
	}

	lines.push(`User shell: ${userShell(status)}`);

	if (status.providerLabel !== undefined) {
		lines.push(`Provider description: ${status.providerLabel}`);
	}

	if (status.policyDescription !== undefined) {
		lines.push(`Boundary: ${status.policyDescription}`);
	}

	if (status.failure !== undefined) {
		lines.push(`Failure: ${status.failure.name}: ${status.failure.message}`);
	}

	const display = lines.map((line) => cleanDisplayText(line));

	if (
		status.closeReport === undefined &&
		status.state === 'failed' &&
		status.failure?.recovery?.kind === 'allocation'
	) {
		display.push(
			formatCleanupReport({
				confirmed: false,
				failures: [],
				recoveries: [status.failure.recovery]
			})
		);
	}

	for (const backend of additional) {
		const id =
			backend.backendId === undefined ? '' : ' ' + quoted(backend.backendId);
		const state =
			status.state === 'closing' || status.state === 'closed'
				? 'last state: ' + backend.state
				: backend.state;

		display.push(
			cleanDisplayText(`Additional backend${id} (${state})`),
			cleanDisplayText(
				backend.effectivePolicy === undefined
					? `Requested policy: ${policy(backend.policy)}`
					: `Effective policy: ${policy(backend.effectivePolicy)}`
			)
		);
	}

	const report = status.closeReport;

	display.push(...formatProviderDiagnostics(status));

	if (report !== undefined) {
		display.push(formatCleanupReport(report));
	}

	return joinDisplayLines(display);
}

export function formatProviderDiagnostics(
	status: Pick<SandboxStatus, 'diagnostics' | 'diagnosticsDropped'>
): readonly DisplayText[] {
	const lines = (status.diagnostics ?? []).map(
		(diagnostic) =>
			`Warning (${diagnostic.operation}, ${diagnostic.operationId}): ${diagnostic.message}`
	);

	if (status.diagnosticsDropped !== undefined) {
		lines.push(`Diagnostics discarded: ${String(status.diagnosticsDropped)}`);
	}

	return lines.map((line) => cleanDisplayText(line));
}

export function formatProviders(
	providers: readonly ProviderInfo[]
): DisplayText {
	const lines = ['Available sandbox providers (declared capabilities):'];

	for (const provider of providers) {
		lines.push(
			`${provider.id}: ${provider.label}`,
			...(provider.policies.workspaceRelationship === undefined
				? []
				: [
						`  Workspace relationships: ${list(provider.policies.workspaceRelationship)}`
					]),
			`  Operations: ${list(provider.capabilities.operations)}`,
			`  Termination scope: ${provider.capabilities.terminationScope}`,
			`  Shells: ${list(provider.capabilities.shells)}`,
			`  Policies: workspace ${list(provider.policies.workspaceAccess)}; filesystem ${list(provider.policies.filesystemScope)}; network ${list(provider.policies.networkAccess)}`
		);
	}

	return joinDisplayLines(lines.map((line) => cleanDisplayText(line)));
}
