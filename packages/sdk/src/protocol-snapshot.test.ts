import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { introducedAt } from './fixtures/protocol-feature.js';
import { protocolSnapshot } from './protocol-snapshot.js';

const base = Type.String({ minLength: 1 });
const first = Type.Object({ id: base }, { additionalProperties: false });
const later = introducedAt(1, Type.String());
const compatible = Type.Object(
	{ id: base, label: Type.Optional(later) },
	{ additionalProperties: false }
);
const changed = Type.Object(
	{ id: Type.String({ minLength: 2 }) },
	{ additionalProperties: false }
);

it('keeps the first snapshot identical when a later level adds an optional field', () => {
	const baseline = protocolSnapshot(1, 0, { service: first });

	expect(protocolSnapshot(1, 0, { service: compatible })).toStrictEqual(
		baseline
	);

	expect(protocolSnapshot(1, 1, { service: compatible })).not.toStrictEqual(
		baseline
	);
	expect(protocolSnapshot(1, 0, { service: changed })).not.toStrictEqual(
		baseline
	);
});

it('records different refinement implementations', () => {
	const odd = Type.Refine(Type.Integer(), (value) => value % 2 !== 0);
	const even = Type.Refine(Type.Integer(), (value) => value % 2 === 0);

	expect(protocolSnapshot(1, 0, { value: odd })).not.toStrictEqual(
		protocolSnapshot(1, 0, { value: even })
	);
});

it('omits a newly introduced message from the previous level', () => {
	const extended = { service: first, next: introducedAt(1, first) };

	expect(protocolSnapshot(1, 0, extended)).toStrictEqual(
		protocolSnapshot(1, 0, { service: first })
	);
});

it('includes later fields in the fixed header at every level', () => {
	expect(protocolSnapshot(1, 0, { envelope: compatible })).not.toStrictEqual(
		protocolSnapshot(1, 0, { envelope: first })
	);
});
