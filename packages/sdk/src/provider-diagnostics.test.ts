import { expect, it } from 'vitest';

import { ProviderDiagnostics } from './provider-diagnostics.js';

const identity = {
	operationId: 'operation',
	operation: 'exec',
	providerId: 'provider',
	backendId: 'backend'
} as const;

it('reads warning fields once before validating and retaining them', () => {
	const diagnostics = new ProviderDiagnostics();
	let reads = 0;

	diagnostics.record(identity, {
		level: 'warning',
		get message() {
			return reads++ === 0 ? 'bounded' : 'x'.repeat(100_000);
		}
	});
	expect(diagnostics.snapshot()).toStrictEqual({
		entries: [{ ...identity, level: 'warning', message: 'bounded' }],
		dropped: 0
	});
});

it('discards throwing getters without failing the provider operation', () => {
	const diagnostics = new ProviderDiagnostics();

	diagnostics.record(identity, {
		level: 'warning',
		get message(): string {
			throw new Error('Private runtime error');
		}
	});
	expect(diagnostics.snapshot()).toStrictEqual({ entries: [], dropped: 1 });
});

it('bounds retained warnings and reports discarded diagnostics', () => {
	const diagnostics = new ProviderDiagnostics();

	for (let index = 0; index < 66; index++) {
		diagnostics.record(identity, {
			level: 'warning',
			message: `warning ${String(index)}`
		});
	}

	expect(diagnostics.snapshot()).toStrictEqual({
		entries: Array.from({ length: 64 }, (_, index) => ({
			...identity,
			level: 'warning',
			message: `warning ${String(index)}`
		})),
		dropped: 2
	});
});

it.each([
	{ label: 'missing fields', value: {} },
	{ label: 'wrong level', value: { level: 'error', message: 'warning' } },
	{ label: 'empty message', value: { level: 'warning', message: '' } },
	{
		label: 'oversized message',
		value: { level: 'warning', message: 'x'.repeat(2049) }
	}
])(
	'discards $label without throwing or recording workload output',
	({ value }) => {
		const diagnostics = new ProviderDiagnostics();

		diagnostics.record(identity, value);
		expect(diagnostics.snapshot()).toStrictEqual({ entries: [], dropped: 1 });
	}
);

it('snapshots warning values and ignores private provider fields', () => {
	const diagnostics = new ProviderDiagnostics();
	const warning = {
		level: 'warning',
		message: 'original',
		privateValue: 'secret'
	};

	diagnostics.record(identity, warning);

	const first = diagnostics.snapshot();

	warning.message = 'changed';
	diagnostics.record(identity, { level: 'warning', message: 'later' });
	expect({
		first,
		frozen: [first, first.entries, ...first.entries].map((entry) =>
			Object.isFrozen(entry)
		)
	}).toStrictEqual({
		first: {
			entries: [{ ...identity, level: 'warning', message: 'original' }],
			dropped: 0
		},
		frozen: [true, true, true]
	});
});
