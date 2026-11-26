import { Type } from 'typebox';
import { expect, it } from 'vitest';

import { introducedAt } from './fixtures/protocol-feature.js';
import { atFeatureLevel, projectOffer, wholeOffer } from './protocol-schema.js';
import { checker, denseArray } from './schemas.js';

const trace = introducedAt(1, Type.Literal('trace'));
const capabilities = denseArray(Type.Union([Type.Literal('exec'), trace]), {
	minItems: 1,
	uniqueItems: true
});
const policy = wholeOffer(
	Type.Object(
		{
			id: Type.String(),
			needs: capabilities
		},
		{ additionalProperties: false }
	)
);
const label = introducedAt(1, Type.String());
const offer = Type.Object(
	{
		id: Type.String(),
		label: Type.Optional(label),
		capabilities,
		profiles: denseArray(policy)
	},
	{ additionalProperties: false }
);

it('generates validators that reject a demand above the shared feature level', () => {
	const demand = { id: 'workspace', needs: ['exec', 'trace'] };

	expect({
		old: checker(atFeatureLevel(policy, 0))(demand),
		new: checker(atFeatureLevel(policy, 1))(demand),
		ordinary: checker(atFeatureLevel(policy, 0))({
			id: 'workspace',
			needs: ['exec']
		}),
		unknown: checker(atFeatureLevel(policy, 1))({ ...demand, guessed: true })
	}).toStrictEqual({
		old: false,
		new: true,
		ordinary: true,
		unknown: false
	});
});

it('reduces offers without dropping a requirement from an advertised policy', () => {
	const provider = {
		id: 'provider',
		label: 'Extra detail',
		capabilities: ['exec', 'trace'],
		profiles: [
			{ id: 'plain', needs: ['exec'] },
			{ id: 'traced', needs: ['exec', 'trace'] }
		]
	};

	expect(projectOffer(offer, provider, 0)).toStrictEqual({
		id: 'provider',
		capabilities: ['exec'],
		profiles: [{ id: 'plain', needs: ['exec'] }]
	});
});

it('preserves array constraints at the lower feature level', () => {
	const sparse = ['exec'];

	sparse.length++;

	expect({
		noItems: projectOffer(capabilities, ['trace'], 0),
		dupes: checker(atFeatureLevel(capabilities, 0))(['exec', 'exec']),
		sparse: checker(atFeatureLevel(capabilities, 0))(sparse)
	}).toStrictEqual({ noItems: undefined, dupes: false, sparse: false });
});

it('requires a new field to be optional within a protocol major', () => {
	const schema = Type.Object({ field: introducedAt(1, Type.String()) });

	expect(() => atFeatureLevel(schema, 0)).toThrow(
		'Protocol field field must be optional when added.'
	);
});

it('removes fields added later even when the object permits other properties', () => {
	const advertisement = Type.Object({
		id: Type.String(),
		label: Type.Optional(label)
	});
	const value = { id: 'provider', label: 'Provider label' };

	expect(projectOffer(advertisement, value, 0)).toStrictEqual({
		id: 'provider'
	});
});
