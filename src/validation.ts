import type {
	SandboxCapabilities,
	SandboxPolicy,
	SupportedSandboxPolicies
} from './contracts.js';
import type { ProviderInfo } from './protocol.js';
import {
	capabilitiesSchema,
	checker,
	nonEmptyStringSchema,
	policySchema,
	providerInfoSchema,
	recordSchema,
	recoverySchema,
	shellSchema
} from './schemas.js';
import { snapshotWorkspaceProtection } from './workspace-protection.js';

export const isRecord = checker(recordSchema);
export const isNonEmptyString = checker(nonEmptyStringSchema);
export const isShell = checker(shellSchema);
export const isCapabilities = checker(capabilitiesSchema);
export const isPolicy = checker(policySchema);
export const isProviderInfo = checker(providerInfoSchema);
export const isRecovery = checker(recoverySchema);

export function snapshotCapabilities(
	value: SandboxCapabilities
): SandboxCapabilities {
	return Object.freeze({
		terminationScope: value.terminationScope,
		processKinds: Object.freeze([...value.processKinds]),
		exitStatus: value.exitStatus,
		operations: Object.freeze([...value.operations]),
		shells: Object.freeze([...value.shells])
	});
}

export function snapshotPolicy(policy: SandboxPolicy): SandboxPolicy {
	return Object.freeze({
		workspaceAccess: policy.workspaceAccess,
		filesystemScope: policy.filesystemScope,
		networkAccess: policy.networkAccess,
		...(policy.workspaceProtection !== undefined && {
			workspaceProtection: snapshotWorkspaceProtection(
				policy.workspaceProtection
			)
		})
	});
}

export function snapshotProviderInfo(provider: ProviderInfo): ProviderInfo {
	return Object.freeze({
		id: provider.id,
		label: provider.label,
		capabilities: snapshotCapabilities(provider.capabilities),
		policies: snapshotPolicies(provider.policies),
		...(provider.defaultPolicy !== undefined && {
			defaultPolicy: snapshotPolicy(provider.defaultPolicy)
		})
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
