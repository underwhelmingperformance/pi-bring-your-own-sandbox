import { setTimeout as delay } from 'node:timers/promises';

import { expect } from 'vitest';

export async function expectVisibleReplacement(
	read: () => Promise<Uint8Array>,
	expected: Uint8Array,
	replacedAt: number
): Promise<void> {
	for (;;) {
		const startedAfterMs = performance.now() - replacedAt;
		const bytes = await read();

		if (Buffer.compare(bytes, expected) === 0) {
			return;
		}

		if (startedAfterMs > 1000) {
			expect(
				bytes,
				`A read started ${startedAfterMs.toFixed(2)} ms after replacement and returned stale bytes.`
			).toStrictEqual(expected);
		}

		await delay(50);
	}
}
