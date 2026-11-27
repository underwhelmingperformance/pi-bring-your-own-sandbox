import { formatCleanupReport } from './cleanup-report.js';
import type { SandboxErrorInfo, SandboxPolicy } from './contracts.js';
import { describeHostUserData } from './credential-locations.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import { passthroughProvider } from './passthrough-provider.js';
import { accessOrder } from './policy-model.js';
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

function policyKey(value: SandboxPolicy): string {
	return JSON.stringify(accessOrder.map((property) => value[property]));
}

function policy(
	value: SandboxPolicy,
	providerId?: string,
	relationship?: string
): string {
	const checkout = relationship === undefined ? '' : ` (${relationship})`;
	const access = value.hostWorkspaceWrites ? 'read-write' : 'read-only';
	const network = value.network ? 'allowed' : 'denied';

	return `workspace ${access}${checkout}, network ${network}, host user data ${describeHostUserData(value.hostUserData, providerId === passthroughProvider.id)}, host system files ${value.hostSystemFiles}`;
}

function userShell(status: SandboxStatus): string {
	const configured = status.selection?.userShell;

	if (configured !== undefined) {
		return status.profile === undefined ||
			status.profile.shells.includes(configured)
			? `${configured} (configured)`
			: `${configured} (configured; unavailable on this backend)`;
	}

	return status.workspace === undefined
		? 'provider default (not opened)'
		: (status.workspace.defaultShell ?? 'unavailable');
}

function failureDetail(error: SandboxErrorInfo): string[] {
	const detail = error.detail;
	const source = error.extensionSource;
	const lines = source === undefined ? [] : [`Extension: ${source}`];

	switch (detail?.kind) {
		case 'access': {
			return [
				...lines,
				`Access: ${detail.property} is ${detail.value} (${detail.reason})`
			];
		}

		case 'path': {
			return [
				...lines,
				`Path: ${detail.access} ${quoted(detail.path)} (${detail.reason})`
			];
		}

		case 'capability': {
			return [
				...lines,
				`Requirement: ${detail.field} = ${JSON.stringify(detail.value)}`
			];
		}

		case 'request': {
			return [
				...lines,
				`Request field: ${detail.field}${detail.value === undefined ? '' : ' = ' + JSON.stringify(detail.value)}`
			];
		}

		case 'config': {
			return [...lines, `Settings key: ${detail.field}`];
		}

		case 'provider-unavailable': {
			return [
				...lines,
				`Unavailable on ${detail.reason.platform}. ${detail.reason.message}`
			];
		}

		case 'declaration': {
			return [...lines, `Declaration: ${detail.field}`];
		}

		default: {
			return lines;
		}
	}
}

export function formatStatus(status: SandboxStatus): DisplayText {
	const selection = status.selection;
	const providerId =
		status.failure?.name === 'SandboxProviderUnavailableError'
			? status.failure.providerId
			: undefined;
	const baseKey =
		selection === undefined ? undefined : policyKey(selection.policy);
	const additional = (status.backends ?? []).filter(
		(backend) => policyKey(backend.policy) !== baseKey
	);
	const lines = [
		selection === undefined
			? providerId === undefined
				? 'Provider: unavailable'
				: `Provider: ${providerId} (unavailable)`
			: `Provider: ${selection.providerId} (${selection.source})`,
		`State: ${status.state}`,
		`Generation: ${status.generationId}`
	];

	if (status.protocol !== undefined) {
		const build = status.protocol;

		lines.push(
			`SDK build: ${build.buildId} (${build.extensionSource})`,
			`Protocol: major ${String(build.major)}, feature level ${String(build.featureLevel)}`
		);
	}

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

	if (status.profile !== undefined) {
		lines.push(
			`Effective policy: ${policy(status.profile.policy, selection?.providerId, status.workspace?.relationship)}`
		);
	}

	if (selection !== undefined && status.profile === undefined) {
		lines.push(
			`Requested policy: ${policy(selection.policy, selection.providerId)}`
		);
	}

	if (status.profile !== undefined) {
		lines.push(
			`Operations: ${list(status.profile.capabilities)}`,
			`Termination scope: ${status.profile.terminationScope}`,
			`Shells: ${list(status.profile.shells)}`
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
		lines.push(
			`Failure: ${status.failure.name}: ${status.failure.message}`,
			...failureDetail(status.failure)
		);
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
					? `Requested policy: ${policy(backend.policy, selection?.providerId)}`
					: `Effective policy: ${policy(backend.effectivePolicy, selection?.providerId)}`
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

function formatProviderDiagnostics(
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
	const lines = ['Sandbox providers (declared profiles)'];

	for (const provider of providers) {
		lines.push(`${provider.id}: ${provider.label}`);

		if (provider.unavailable !== undefined) {
			lines.push(
				`  Unavailable on ${provider.unavailable.platform}. ${provider.unavailable.message}`
			);
		}

		const modes = ['open', 'copy'] as const;

		for (const mode of modes) {
			const profiles = provider.profiles[mode];

			for (const profile of profiles) {
				lines.push(
					`  ${mode}: ${policy(profile.policy, provider.id, mode === 'copy' ? 'copied' : 'shared')}`,
					`    Operations: ${list(profile.capabilities)}`,
					`    Termination scope: ${profile.terminationScope}`,
					`    Shells: ${list(profile.shells)}`
				);
			}
		}
	}

	return joinDisplayLines(lines.map((line) => cleanDisplayText(line)));
}
