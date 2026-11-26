import type { SandboxCapabilities, SandboxPolicy } from '../contracts.js';
import type { Profile } from '../policy-model.js';
import { defaultPolicy } from '../policy-model.js';

export function fixtureProfile(
	policy: SandboxPolicy,
	capabilities: SandboxCapabilities
): Profile {
	return {
		policy,
		capabilities: capabilities.operations,
		processKinds: capabilities.processKinds,
		shells: capabilities.shells,
		exitStatus: capabilities.exitStatus,
		terminationScope: capabilities.terminationScope
	};
}

export type FixturePolicyChoices = {
	readonly [
		Property in keyof SandboxPolicy
	]?: readonly SandboxPolicy[Property][];
};

export function fixtureProfiles(
	capabilities: SandboxCapabilities,
	choices: FixturePolicyChoices
): { readonly open: readonly Profile[]; readonly copy: readonly Profile[] } {
	const workspace = choices.hostWorkspaceWrites ?? [
		defaultPolicy.hostWorkspaceWrites
	];
	const networks = choices.network ?? [defaultPolicy.network];
	const userData = choices.hostUserData ?? [defaultPolicy.hostUserData];
	const systemFiles = choices.hostSystemFiles ?? [
		defaultPolicy.hostSystemFiles
	];
	const policies: SandboxPolicy[] = [];

	for (const isHostWorkspaceWrites of workspace) {
		for (const isNetwork of networks) {
			for (const hostUserData of userData) {
				for (const hostSystemFiles of systemFiles) {
					policies.push({
						hostWorkspaceWrites: isHostWorkspaceWrites,
						network: isNetwork,
						hostUserData,
						hostSystemFiles
					});
				}
			}
		}
	}

	const open = policies.map((policy) => fixtureProfile(policy, capabilities));
	const copy = capabilities.operations.includes('copy')
		? open.filter((profile) => !profile.policy.hostWorkspaceWrites)
		: [];

	return {
		open,
		copy:
			capabilities.operations.includes('copy') && copy.length === 0
				? [
						fixtureProfile(
							{ ...defaultPolicy, hostWorkspaceWrites: false },
							capabilities
						)
					]
				: copy
	};
}

export function firstOpenProfile(provider: {
	readonly profiles: { readonly open: readonly Profile[] };
}): Profile {
	const [profile] = provider.profiles.open;

	if (profile === undefined) {
		throw new Error('The fixture provider declares no open profile.');
	}

	return profile;
}

export function firstCopyProfile(provider: {
	readonly profiles: { readonly copy: readonly Profile[] };
}): Profile {
	const [profile] = provider.profiles.copy;

	if (profile === undefined) {
		throw new Error('The fixture provider declares no copy profile.');
	}

	return profile;
}
