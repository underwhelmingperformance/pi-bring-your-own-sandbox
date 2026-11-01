import type {
	SandboxCapabilities,
	SupportedSandboxPolicies
} from './contracts.js';
import {
	capabilitiesSchema,
	checker,
	nonEmptyStringSchema,
	providerInfoSchema,
	recordSchema,
	recoverySchema,
	shellSchema
} from './schemas.js';

export const isRecord = checker(recordSchema);
export const isNonEmptyString = checker(nonEmptyStringSchema);
export const isShell = checker(shellSchema);
export const isCapabilities = checker(capabilitiesSchema);
export const isProviderInfo = checker(providerInfoSchema);
export const isRecovery = checker(recoverySchema);

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
