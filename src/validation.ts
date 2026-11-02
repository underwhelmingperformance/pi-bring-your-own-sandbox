import type {
	SandboxCapabilities,
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

export function snapshotProviderInfo(provider: ProviderInfo): ProviderInfo {
	return Object.freeze({
		id: provider.id,
		label: provider.label,
		capabilities: snapshotCapabilities(provider.capabilities),
		policies: snapshotPolicies(provider.policies),
		...(provider.defaultPolicy !== undefined && {
			defaultPolicy: Object.freeze({
				workspaceAccess: provider.defaultPolicy.workspaceAccess,
				filesystemScope: provider.defaultPolicy.filesystemScope,
				networkAccess: provider.defaultPolicy.networkAccess
			})
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
