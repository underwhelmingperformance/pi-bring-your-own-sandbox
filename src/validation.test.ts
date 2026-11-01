import { expect, it } from 'vitest';

import { isCapabilities, isUniqueList } from './validation.js';

it.each(['operations', 'shells'] as const)(
	'rejects holes in capability %s arrays',
	(field) => {
		const sparse: string[] = field === 'operations' ? ['exec'] : [];

		sparse.length++;

		const capabilities = {
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
	expect(
		isUniqueList(
			versions,
			(value): value is number => typeof value === 'number'
		)
	).toBe(false);
});
