import { expect, it } from 'vitest';

import type {
	Access,
	AccessProperty,
	Policy,
	Profile
} from './policy-model.js';
import {
	defaultPolicy,
	profileKey,
	profileSchema,
	unrestrictedPolicy
} from './policy-model.js';
import { selectProfile } from './profile-negotiation.js';
import { checker } from './schemas.js';

const profile: Profile = {
	policy: unrestrictedPolicy,
	capabilities: ['exec'],
	processKinds: ['argv'],
	shells: [],
	exitStatus: 'guaranteed',
	terminationScope: 'workload'
};

function withPolicy(policy: Policy): Profile {
	return { ...profile, policy };
}

const exactCases = {
	hostWorkspaceWrites: { denied: false, allowed: true },
	network: { denied: false, allowed: true },
	hostUserData: { denied: 'denied', allowed: 'read-write' },
	hostSystemFiles: { denied: 'denied', allowed: 'read-write' }
} as const satisfies {
	[Property in AccessProperty]: {
		readonly denied: Policy[Property];
		readonly allowed: Policy[Property];
	};
};

it.each(Object.entries(exactCases))(
	'applies omitted, needed and prevented to an independent %s setting',
	(property, { denied, allowed }) => {
		const deniedPolicy = { ...unrestrictedPolicy, [property]: denied };
		const allowedPolicy = { ...unrestrictedPolicy, [property]: allowed };
		const profiles = [withPolicy(deniedPolicy), withPolicy(allowedPolicy)];
		const select = (access?: Access) =>
			selectProfile({
				profiles,
				limit: allowedPolicy,
				requirements: { ...(access !== undefined && { access }) }
			});

		expect({
			omitted: select(),
			needed: select({ [property]: 'needed' }),
			prevented: select({ [property]: 'prevented' })
		}).toStrictEqual({
			omitted: { ok: true, profile: withPolicy(allowedPolicy) },
			needed: { ok: true, profile: withPolicy(allowedPolicy) },
			prevented: { ok: true, profile: withPolicy(deniedPolicy) }
		});
	}
);

it('narrows an omitted property when a restriction excludes correlated profiles', () => {
	const preferred = withPolicy({
		...unrestrictedPolicy,
		hostUserData: 'read-only'
	});
	const offline = withPolicy({
		...preferred.policy,
		network: false,
		hostUserData: 'denied'
	});
	const profiles = [offline, preferred];
	const limit = preferred.policy;

	expect({
		ordinary: selectProfile({ profiles, limit }),
		offline: selectProfile({
			profiles,
			limit,
			requirements: { access: { network: 'prevented' } }
		}),
		both: selectProfile({
			profiles,
			limit,
			requirements: { access: { network: 'prevented', hostUserData: 'needed' } }
		})
	}).toStrictEqual({
		ordinary: { ok: true, profile: preferred },
		offline: { ok: true, profile: offline },
		both: {
			ok: false,
			detail: {
				kind: 'access',
				property: 'hostUserData',
				value: 'needed',
				reason: 'profile'
			}
		}
	});
});

it('narrows only to supported profiles within the SDK default', () => {
	const widest = withPolicy(unrestrictedPolicy);
	const confined = withPolicy({ ...defaultPolicy, hostSystemFiles: 'denied' });
	const readOnly = withPolicy({
		...confined.policy,
		hostWorkspaceWrites: false
	});

	expect(
		selectProfile({
			profiles: [readOnly, widest, confined],
			limit: defaultPolicy
		})
	).toStrictEqual({ ok: true, profile: confined });
});

it.each([
	{
		kind: 'read',
		location: 'host-user-data',
		operation: 'open',
		allowed: false
	},
	{
		kind: 'read',
		location: 'host-system-files',
		operation: 'open',
		allowed: true
	},
	{
		kind: 'write',
		location: 'host-system-files',
		operation: 'open',
		allowed: false
	},
	{ kind: 'write', location: 'workspace', operation: 'open', allowed: false },
	{ kind: 'write', location: 'workspace', operation: 'copy', allowed: true }
] as const)(
	'checks that a $kind grant to $location fits the $operation policy',
	({ kind, location, operation, allowed }) => {
		const policy: Policy = { ...defaultPolicy, hostWorkspaceWrites: false };
		const candidate = withPolicy(policy);
		const path = '/fixture/dependency';

		expect(
			selectProfile({
				profiles: [candidate],
				limit: policy,
				mode: operation,
				paths: [{ kind, location, path }]
			})
		).toStrictEqual(
			allowed
				? { ok: true, profile: candidate }
				: {
						ok: false,
						detail: { kind: 'path', access: kind, path, reason: 'limit' }
					}
		);
	}
);

it('chooses a stable profile for equal policies regardless of declaration or metadata order', () => {
	const shell: Profile = {
		...profile,
		processKinds: ['shell', 'argv'],
		shells: ['sh', 'bash']
	};
	const alternative: Profile = {
		...profile,
		capabilities: ['exec', 'files.read']
	};
	const equivalent: Profile = {
		...shell,
		processKinds: ['argv', 'shell'],
		shells: ['bash', 'sh']
	};
	const forward = selectProfile({
		profiles: [alternative, shell],
		limit: unrestrictedPolicy
	});
	const reverse = selectProfile({
		profiles: [shell, alternative],
		limit: unrestrictedPolicy
	});

	expect({
		forward,
		reverse,
		equivalent: profileKey(equivalent)
	}).toStrictEqual({
		forward: { ok: true, profile: alternative },
		reverse: { ok: true, profile: alternative },
		equivalent: profileKey(shell)
	});
});

it('checks profile metadata consistency', () => {
	const isProfile = checker(profileSchema);

	expect({
		valid: isProfile(profile),
		duplicates: isProfile({ ...profile, capabilities: ['exec', 'exec'] }),
		inconsistentShells: isProfile({ ...profile, shells: ['sh'] })
	}).toStrictEqual({
		valid: true,
		duplicates: false,
		inconsistentShells: false
	});
});
