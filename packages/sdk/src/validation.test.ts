import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { defaultPolicy, profileSchema } from './policy-model.js';
import { checker, denseArray } from './schemas.js';

const isProfile = checker(profileSchema);

it.each(['capabilities', 'shells'] as const)(
	'rejects holes in capability %s arrays',
	(field) => {
		const sparse: string[] = field === 'capabilities' ? ['exec'] : [];

		sparse.length++;

		const profile = {
			policy: defaultPolicy,
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			capabilities: ['exec', 'search.find'],
			shells: [],
			[field]: sparse
		};

		expect(isProfile(profile)).toBe(false);
	}
);

it('rejects sparse version lists without treating missing elements as versions', () => {
	const versions: number[] = [];

	versions.length = 1;

	const isVersions = checker(denseArray(Type.Number(), { uniqueItems: true }));

	expect(isVersions(versions)).toBe(false);
});
