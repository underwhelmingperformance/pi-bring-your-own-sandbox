import type { SandboxPolicy } from '../contracts.js';
import type { Profile } from '../policy-model.js';
import { defaultPolicy } from '../policy-model.js';

export type FixtureCapabilities = Pick<
	Profile,
	'processKinds' | 'shells' | 'exitStatus' | 'terminationScope'
> & { readonly operations: Profile['capabilities'] };

export function profileCapabilities(profile: Profile): FixtureCapabilities {
	return { ...profile, operations: profile.capabilities };
}

export function fixtureProfile(
	policy: SandboxPolicy,
	capabilities: FixtureCapabilities
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
	capabilities: FixtureCapabilities,
	choices: FixturePolicyChoices,
	hasCopy = false
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
	const copy = hasCopy
		? open.filter((profile) => !profile.policy.hostWorkspaceWrites)
		: [];

	return {
		open,
		copy:
			hasCopy && copy.length === 0
				? [
						fixtureProfile(
							{ ...defaultPolicy, hostWorkspaceWrites: false },
							capabilities
						)
					]
				: copy
	};
}

export {
	firstCopyProfile,
	firstOpenProfile
} from '../../../../test-support/provider-profiles.js';
