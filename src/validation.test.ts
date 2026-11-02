import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { checker, denseArray } from './schemas.js';
import { isCapabilities } from './validation.js';

it.each(['operations', 'shells'] as const)(
	'rejects holes in capability %s arrays',
	(field) => {
		const sparse: string[] = field === 'operations' ? ['exec'] : [];

		sparse.length++;

		const capabilities = {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec', 'search.find'],
			shells: [],
			[field]: sparse
		};

		expect(isCapabilities(capabilities)).toBe(false);
	}
);

it('rejects sparse version lists without treating missing elements as versions', () => {
	const versions: number[] = [];

	versions.length = 1;

	const isVersions = checker(denseArray(Type.Number(), { uniqueItems: true }));

	expect(isVersions(versions)).toBe(false);
});
