import type {
	RecoveryDescriptor,
	SandboxCapabilities,
	SandboxCapability,
	SandboxPolicy,
	ShellDialect,
	SupportedSandboxPolicies
} from './contracts.js';
import type { ProviderInfo } from './protocol.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isNonEmptyString(value: unknown): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function isShell(value: unknown): value is ShellDialect {
	return (
		typeof value === 'string' && ['bash', 'sh', 'powershell'].includes(value)
	);
}

export function isCapability(value: unknown): value is SandboxCapability {
	return (
		typeof value === 'string' &&
		[
			'exec',
			'files.read',
			'files.write',
			'files.list',
			'search.find',
			'search.grep'
		].includes(value)
	);
}

export function isUniqueList<Item>(
	value: unknown,
	isItem: (item: unknown) => item is Item
): value is readonly Item[] {
	if (!Array.isArray(value)) {
		return false;
	}

	const items: readonly unknown[] = value;

	return items.values().every(isItem) && new Set(items).size === items.length;
}

export function isCapabilities(value: unknown): value is SandboxCapabilities {
	return (
		isRecord(value) &&
		isUniqueList(value.operations, isCapability) &&
		isUniqueList(value.shells, isShell) &&
		value.operations.includes('exec')
	);
}

export function isWorkspaceAccess(
	value: unknown
): value is SandboxPolicy['workspaceAccess'] {
	return value === 'read-only' || value === 'read-write';
}

export function isFilesystemScope(
	value: unknown
): value is SandboxPolicy['filesystemScope'] {
	return value === 'workspace-only' || value === 'provider-default';
}

export function isNetworkAccess(
	value: unknown
): value is SandboxPolicy['networkAccess'] {
	return value === 'denied' || value === 'provider-default';
}

export function isPolicy(value: unknown): value is SandboxPolicy {
	return (
		isRecord(value) &&
		isWorkspaceAccess(value.workspaceAccess) &&
		isFilesystemScope(value.filesystemScope) &&
		isNetworkAccess(value.networkAccess)
	);
}

export function isSupportedPolicies(
	value: unknown
): value is SupportedSandboxPolicies {
	return (
		isRecord(value) &&
		isUniqueList(value.workspaceAccess, isWorkspaceAccess) &&
		value.workspaceAccess.length > 0 &&
		isUniqueList(value.filesystemScope, isFilesystemScope) &&
		value.filesystemScope.length > 0 &&
		isUniqueList(value.networkAccess, isNetworkAccess) &&
		value.networkAccess.length > 0
	);
}

export function isProviderInfo(value: unknown): value is ProviderInfo {
	return (
		isRecord(value) &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.label) &&
		isCapabilities(value.capabilities) &&
		isSupportedPolicies(value.policies)
	);
}

export function isRecovery(value: unknown): value is RecoveryDescriptor {
	if (!isRecord(value)) {
		return false;
	}

	if (value.kind === 'none') {
		return true;
	}

	return (
		value.kind === 'allocation' &&
		isNonEmptyString(value.id) &&
		isNonEmptyString(value.instructions) &&
		isNonEmptyString(value.lease) &&
		(value.expiresAt === undefined ||
			(typeof value.expiresAt === 'string' &&
				Number.isFinite(Date.parse(value.expiresAt))))
	);
}

export function snapshotCapabilities(
	value: SandboxCapabilities
): SandboxCapabilities {
	return Object.freeze({
		operations: Object.freeze([...value.operations]),
		shells: Object.freeze([...value.shells])
	});
}

export function snapshotPolicies(
	value: SupportedSandboxPolicies
): SupportedSandboxPolicies {
	return Object.freeze({
		workspaceAccess: Object.freeze([...value.workspaceAccess]),
		filesystemScope: Object.freeze([...value.filesystemScope]),
		networkAccess: Object.freeze([...value.networkAccess])
	});
}
