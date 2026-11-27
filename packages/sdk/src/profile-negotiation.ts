import { isWithinHostRoots } from './path-grants.js';
import type {
	Access,
	AccessProperty,
	AccessState,
	Policy,
	Profile
} from './policy-model.js';
import { accessOrder, accessRanks, profileKey } from './policy-model.js';
import { isTerminationScopeSatisfied } from './termination-scope.js';

export type ProfileMode = 'open' | 'copy';

export interface ProfileRequirements {
	readonly access?: Access;
	readonly capabilities?: readonly Profile['capabilities'][number][];
	readonly processKinds?: readonly Profile['processKinds'][number][];
	readonly shells?: readonly Profile['shells'][number][];
	readonly exitStatus?: 'guaranteed';
	readonly terminationScope?: Profile['terminationScope'];
}

export interface ResolvedPath {
	readonly path: string;
	readonly kind: 'read' | 'write';
	readonly location: 'workspace' | 'host-user-data' | 'host-system-files';
	readonly isCredential?: true;
}

type CapabilityFailure =
	| {
			readonly field: 'capabilities';
			readonly value: Profile['capabilities'][number];
	  }
	| {
			readonly field: 'processKinds';
			readonly value: Profile['processKinds'][number];
	  }
	| { readonly field: 'shells'; readonly value: Profile['shells'][number] }
	| { readonly field: 'exitStatus'; readonly value: 'guaranteed' }
	| {
			readonly field: 'terminationScope';
			readonly value: Profile['terminationScope'];
	  };

export type ProfileRefusal =
	| { readonly kind: 'policy'; readonly reason: 'profile' }
	| {
			readonly kind: 'access';
			readonly property: AccessProperty;
			readonly value: AccessState;
			readonly reason: 'limit' | 'profile';
	  }
	| {
			readonly kind: 'path';
			readonly access: ResolvedPath['kind'];
			readonly path: string;
			readonly reason: 'limit' | 'profile';
	  }
	| ({ readonly kind: 'capability' } & CapabilityFailure);

export type ProfileSelection =
	| { readonly ok: true; readonly profile: Profile }
	| { readonly ok: false; readonly detail: ProfileRefusal };

interface ProfileRequest {
	readonly profiles: readonly Profile[];
	readonly limit: Policy;
	readonly requirements?: ProfileRequirements;
	readonly mode?: ProfileMode;
	readonly paths?: readonly ResolvedPath[];
	readonly hostUserDataRoots?: readonly string[];
	readonly isEscalated?: boolean;
	readonly isUnrestrictedHost?: boolean;
}

const satisfiesAccess = {
	hostWorkspaceWrites: (policy: Policy, state: AccessState) =>
		policy.hostWorkspaceWrites === (state === 'needed'),
	network: (policy: Policy, state: AccessState) =>
		policy.network === (state === 'needed'),
	hostUserData: (policy: Policy, state: AccessState) =>
		(policy.hostUserData !== 'denied') === (state === 'needed'),
	hostSystemFiles: (policy: Policy, state: AccessState) =>
		(policy.hostSystemFiles !== 'denied') === (state === 'needed')
} satisfies Record<
	AccessProperty,
	(policy: Policy, state: AccessState) => boolean
>;

export function isWithinLimit(policy: Policy, limit: Policy): boolean {
	return accessOrder.every((property) => {
		const rank = accessRanks[property];

		return rank(policy) <= rank(limit);
	});
}

function compareProfiles(
	left: Profile,
	right: Profile,
	isEscalated: boolean
): number {
	for (const property of accessOrder) {
		const rank = accessRanks[property];
		const difference = rank(left.policy) - rank(right.policy);

		if (difference !== 0) {
			return isEscalated ? difference : -difference;
		}
	}

	const leftKey = profileKey(left);
	const rightKey = profileKey(right);

	return Number(leftKey > rightKey) - Number(leftKey < rightKey);
}

function canGrantPath(
	policy: Policy,
	path: ResolvedPath,
	mode: ProfileMode,
	isUnrestrictedHost: boolean,
	isWithinScope: boolean
): boolean {
	if (path.location === 'workspace') {
		return (
			path.kind === 'read' || mode === 'copy' || policy.hostWorkspaceWrites
		);
	}

	if (
		!isWithinScope ||
		(!isUnrestrictedHost && path.isCredential === true) ||
		(mode === 'copy' && path.kind === 'write')
	) {
		return false;
	}

	const access =
		path.location === 'host-system-files'
			? policy.hostSystemFiles
			: policy.hostUserData;

	return (
		access === 'read-write' || (access === 'read-only' && path.kind === 'read')
	);
}

function capabilityChecks(requirements: ProfileRequirements) {
	const { capabilities = [], processKinds = [], shells = [] } = requirements;

	const checks: {
		readonly detail: CapabilityFailure;
		readonly isSatisfiedBy: (profile: Profile) => boolean;
	}[] = Array.from(capabilities, (value) => ({
		detail: { field: 'capabilities', value },
		isSatisfiedBy: (profile) => profile.capabilities.includes(value)
	}));

	for (const value of processKinds) {
		checks.push({
			detail: { field: 'processKinds', value },
			isSatisfiedBy: (profile) => profile.processKinds.includes(value)
		});
	}

	for (const value of shells) {
		checks.push({
			detail: { field: 'shells', value },
			isSatisfiedBy: (profile) => profile.shells.includes(value)
		});
	}

	if (requirements.exitStatus === 'guaranteed') {
		checks.push({
			detail: { field: 'exitStatus', value: 'guaranteed' },
			isSatisfiedBy: (profile) => profile.exitStatus === 'guaranteed'
		});
	}

	const scope = requirements.terminationScope;

	if (scope !== undefined) {
		checks.push({
			detail: { field: 'terminationScope', value: scope },
			isSatisfiedBy: (profile) =>
				isTerminationScopeSatisfied(profile.terminationScope, scope)
		});
	}

	return checks;
}

export function selectProfile({
	profiles,
	limit,
	requirements = {},
	mode = 'open',
	paths = [],
	hostUserDataRoots = [],
	isEscalated = false,
	isUnrestrictedHost = false
}: ProfileRequest): ProfileSelection {
	let eligible = profiles.filter(({ policy }) =>
		isEscalated
			? accessOrder.every(
					(property) =>
						requirements.access?.[property] !== undefined ||
						policy[property] === limit[property]
				)
			: isWithinLimit(policy, limit)
	);

	if (eligible.length === 0) {
		return { ok: false, detail: { kind: 'policy', reason: 'profile' } };
	}

	for (const property of accessOrder) {
		const state = requirements.access?.[property];

		if (state === undefined) {
			continue;
		}

		const isSatisfiedBy = satisfiesAccess[property];

		if (!isEscalated && state === 'needed' && !isSatisfiedBy(limit, state)) {
			return {
				ok: false,
				detail: { kind: 'access', property, value: state, reason: 'limit' }
			};
		}

		const requiresReadOnly =
			isEscalated &&
			!isUnrestrictedHost &&
			property === 'hostUserData' &&
			state === 'needed';

		eligible = eligible.filter(({ policy }) =>
			requiresReadOnly
				? policy.hostUserData === 'read-only'
				: isSatisfiedBy(policy, state)
		);

		if (eligible.length === 0) {
			return {
				ok: false,
				detail: { kind: 'access', property, value: state, reason: 'profile' }
			};
		}
	}

	for (const path of paths) {
		const isWithinScope =
			isUnrestrictedHost ||
			path.location !== 'host-user-data' ||
			isWithinHostRoots(path.path, hostUserDataRoots);

		if (
			!isEscalated &&
			!canGrantPath(limit, path, mode, isUnrestrictedHost, isWithinScope)
		) {
			return {
				ok: false,
				detail: {
					kind: 'path',
					access: path.kind,
					path: path.path,
					reason: 'limit'
				}
			};
		}

		eligible = eligible.filter(
			(profile) =>
				canGrantPath(
					profile.policy,
					path,
					mode,
					isUnrestrictedHost,
					isWithinScope
				) ||
				(isEscalated &&
					mode === 'open' &&
					path.location !== 'workspace' &&
					profile.pathGrantKinds?.includes(path.kind) === true &&
					(path.isCredential !== true ||
						profile.credentialPathGrantKinds?.includes(path.kind) === true))
		);

		if (eligible.length === 0) {
			return {
				ok: false,
				detail: {
					kind: 'path',
					access: path.kind,
					path: path.path,
					reason: 'profile'
				}
			};
		}
	}

	for (const { isSatisfiedBy, detail } of capabilityChecks(requirements)) {
		eligible = eligible.filter((profile) => isSatisfiedBy(profile));

		if (eligible.length === 0) {
			return { ok: false, detail: { kind: 'capability', ...detail } };
		}
	}

	const [selected] = eligible.toSorted((left, right) =>
		compareProfiles(left, right, isEscalated)
	);

	return selected === undefined
		? { ok: false, detail: { kind: 'policy', reason: 'profile' } }
		: { ok: true, profile: selected };
}
