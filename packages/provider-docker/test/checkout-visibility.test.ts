import { afterEach, expect, it, vi } from 'vitest';

import { expectVisibleReplacement } from './checkout-visibility.js';

const encoder = new TextEncoder();
const expected = encoder.encode('replacement');

function reads(
	initialTime: number,
	samples: readonly (readonly [number, string])[]
) {
	let time = initialTime;
	const observations: { start: number; finish: number; content: string }[] = [];
	const pending = [...samples];

	vi.spyOn(performance, 'now').mockImplementation(() => time);

	return {
		observations,
		read: async () => {
			const sample = pending.shift();

			if (sample === undefined) {
				throw new Error('The visibility check made an unexpected read.');
			}

			const [duration, content] = sample;
			const start = time;

			await Promise.resolve();
			time += duration;
			observations.push({ start, finish: time, content });

			return encoder.encode(content);
		}
	};
}

afterEach(() => {
	vi.restoreAllMocks();
});

it.each([
	{
		label: 'accepts a fresh reply which completes after the visibility window',
		initialTime: 0,
		samples: [[1250, 'replacement']] as const,
		observations: [{ start: 0, finish: 1250, content: 'replacement' }]
	},
	{
		label: 'retries a stale read which started at the end of the window',
		initialTime: 1000,
		samples: [
			[50, 'replace'],
			[20, 'replacement']
		] as const,
		observations: [
			{ start: 1000, finish: 1050, content: 'replace' },
			{ start: 1050, finish: 1070, content: 'replacement' }
		]
	}
])('$label', async ({ initialTime, samples, observations }) => {
	const probe = reads(initialTime, samples);

	await expectVisibleReplacement(probe.read, expected, 0);

	expect(probe.observations).toStrictEqual(observations);
});

it('fails a stale read which started after the visibility window', async () => {
	const probe = reads(1001, [
		[5, 'replace'],
		[5, 'replacement']
	]);

	await expect(
		expectVisibleReplacement(probe.read, expected, 0)
	).rejects.toThrow(
		'A read started 1001.00 ms after replacement and returned stale bytes.'
	);
	expect(probe.observations).toStrictEqual([
		{ start: 1001, finish: 1006, content: 'replace' }
	]);
});
