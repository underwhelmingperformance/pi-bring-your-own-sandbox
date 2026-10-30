import { formatCleanupReport } from './cleanup-report.js';
import type { SandboxPolicy } from './contracts.js';
import type { ProviderInfo, SandboxStatus } from './protocol.js';

function list(values: readonly string[]): string {
	return values.length === 0 ? 'none' : values.join(', ');
}

function policy(value: SandboxPolicy): string {
	return `workspace ${value.workspaceAccess}; filesystem ${value.filesystemScope}; network ${value.networkAccess}`;
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

export function formatStatus(status: SandboxStatus): string {
	const selection = status.selection;
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
			? 'Target: not opened'
			: `Target: ${status.workspace.root} (${status.workspace.relationship})`
	);
	if (status.policy !== undefined) {
		lines.push(`Effective policy: ${policy(status.policy)}`);
	}
	if (selection !== undefined && status.policy === undefined) {
		lines.push(`Requested policy: ${policy(selection.policy)}`);
	}
	if (status.capabilities !== undefined) {
		lines.push(
			`Operations: ${list(status.capabilities.operations)}`,
			`Shells: ${list(status.capabilities.shells)}`
		);
	}
	lines.push(`User shell: ${userShell(status)}`);
	if (selection?.providerId === 'passthrough') {
		lines.push('Host execution without isolation.');
	}
	if (status.policyDescription !== undefined) {
		lines.push(`Boundary: ${status.policyDescription}`);
	}
	if (status.failure !== undefined) {
		lines.push(`Failure: ${status.failure.name}: ${status.failure.message}`);
	}
	const report = status.closeReport;
	if (report !== undefined) {
		lines.push(formatCleanupReport(report));
	} else if (
		status.state === 'failed' &&
		status.failure?.recovery?.kind === 'allocation'
	) {
		lines.push(
			formatCleanupReport({
				confirmed: false,
				failures: [],
				recoveries: [status.failure.recovery]
			})
		);
	}
	return lines.join('\n');
}

export function formatProviders(providers: readonly ProviderInfo[]): string {
	const lines = ['Available sandbox providers (declared capabilities):'];
	for (const provider of providers) {
		lines.push(
			`${provider.id}: ${provider.label}`,
			`  Operations: ${list(provider.capabilities.operations)}`,
			`  Shells: ${list(provider.capabilities.shells)}`,
			`  Policies: workspace ${list(provider.policies.workspaceAccess)}; filesystem ${list(provider.policies.filesystemScope)}; network ${list(provider.policies.networkAccess)}`
		);
	}
	return lines.join('\n');
}
