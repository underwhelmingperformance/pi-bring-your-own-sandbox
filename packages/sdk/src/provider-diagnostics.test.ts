import { expect, it } from 'vitest';

import { ProviderDiagnostics } from './provider-diagnostics.js';

const identity = {
	operationId: 'operation',
	operation: 'exec',
	providerId: 'provider',
	backendId: 'backend'
} as const;

it('bounds retained warnings and reports discarded diagnostics', () => {
	const diagnostics = new ProviderDiagnostics();

	for (let index = 0; index < 66; index++) {
		diagnostics.record(identity, `warning ${String(index)}`);
	}

	expect(diagnostics.snapshot()).toStrictEqual({
		entries: Array.from({ length: 64 }, (_, index) => ({
			...identity,
			message: `warning ${String(index)}`
		})),
		dropped: 2
	});
});

it.each([
	{ label: 'an object', value: { level: 'warning', message: 'warning' } },
	{ label: 'an empty message', value: '' },
	{ label: 'a message over the UTF-16 limit', value: '🦉'.repeat(1025) }
])('discards $label', ({ value }) => {
	const diagnostics = new ProviderDiagnostics();

	diagnostics.record(identity, value);
	expect(diagnostics.snapshot()).toStrictEqual({ entries: [], dropped: 1 });
});

it('retains a message exactly at the UTF-16 limit in a frozen snapshot', () => {
	const diagnostics = new ProviderDiagnostics();
	const message = '🦉'.repeat(1024);

	diagnostics.record(identity, message);

	const first = diagnostics.snapshot();

	diagnostics.record(identity, 'later');
	expect({
		first,
		frozen: [first, first.entries, ...first.entries].map((entry) =>
			Object.isFrozen(entry)
		)
	}).toStrictEqual({
		first: {
			entries: [{ ...identity, message }],
			dropped: 0
		},
		frozen: [true, true, true]
	});
});
