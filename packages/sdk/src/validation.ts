import type { SandboxCapabilities, SandboxPolicy } from './contracts.js';
import type { Profile } from './policy-model.js';
import { accessPolicySchema, providerInfoSchema } from './policy-model.js';
import type { ProviderInfo } from './protocol.js';
import {
	checker,
	nonEmptyStringSchema,
	recordSchema,
	recoverySchema,
	shellSchema
} from './schemas.js';

export const isRecord = checker(recordSchema);
export const isNonEmptyString = checker(nonEmptyStringSchema);
export const isShell = checker(shellSchema);
export const isPolicy = checker(accessPolicySchema);
export const isProviderInfo = checker(providerInfoSchema);
export const isRecovery = checker(recoverySchema);

function snapshotCapabilities(value: SandboxCapabilities): SandboxCapabilities {
	return Object.freeze({
		terminationScope: value.terminationScope,
		processKinds: Object.freeze([...value.processKinds]),
		exitStatus: value.exitStatus,
		operations: Object.freeze([...value.operations]),
		shells: Object.freeze([...value.shells])
	});
}

export function snapshotPolicy(policy: SandboxPolicy): SandboxPolicy {
	return Object.freeze({ ...policy });
}

export function snapshotProfile(profile: Profile): Profile {
	return Object.freeze({
		policy: snapshotPolicy(profile.policy),
		capabilities: Object.freeze([...profile.capabilities]),
		processKinds: Object.freeze([...profile.processKinds]),
		shells: Object.freeze([...profile.shells]),
		exitStatus: profile.exitStatus,
		terminationScope: profile.terminationScope,
		...(profile.pathGrantKinds !== undefined && {
			pathGrantKinds: Object.freeze([...profile.pathGrantKinds])
		}),
		...(profile.credentialPathGrantKinds !== undefined && {
			credentialPathGrantKinds: Object.freeze([
				...profile.credentialPathGrantKinds
			])
		})
	});
}

export function profileCapabilities(profile: Profile): SandboxCapabilities {
	return snapshotCapabilities({ ...profile, operations: profile.capabilities });
}

export function snapshotProviderInfo(provider: ProviderInfo): ProviderInfo {
	const open = provider.profiles.open.map((profile) =>
		snapshotProfile(profile)
	);
	const copy = provider.profiles.copy.map((profile) =>
		snapshotProfile(profile)
	);

	return Object.freeze({
		id: provider.id,
		label: provider.label,
		profiles: Object.freeze({
			open: Object.freeze(open),
			copy: Object.freeze(copy)
		})
	});
}
