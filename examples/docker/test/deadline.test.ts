import { afterEach, expect, it, vi } from 'vitest';

import { remainingBudget } from '../../../src/fixtures/remaining-budget.js';
import { DeadlineTimer } from '../src/deadline.js';

afterEach(() => {
	vi.useRealTimers();
});

it('reschedules long deadlines without expiring at the first timer boundary', async () => {
	vi.useFakeTimers();

	const expired = vi.fn();
	const timer = new DeadlineTimer(remainingBudget(3_000_000_000), expired);

	try {
		await vi.advanceTimersByTimeAsync(2_147_483_647);
		expect(expired.mock.calls).toStrictEqual([]);
		await vi.advanceTimersByTimeAsync(3_000_000_000 - 2_147_483_647);
		expect(expired.mock.calls).toStrictEqual([[]]);
	} finally {
		timer.dispose();
	}
});

it('cancels the remaining wait after a long deadline is rescheduled', async () => {
	vi.useFakeTimers();

	const expired = vi.fn();
	const timer = new DeadlineTimer(remainingBudget(3_000_000_000), expired);

	await vi.advanceTimersByTimeAsync(2_147_483_647);
	timer.dispose();
	await vi.advanceTimersByTimeAsync(3_000_000_000);
	expect({
		calls: expired.mock.calls,
		timers: vi.getTimerCount()
	}).toStrictEqual({
		calls: [],
		timers: 0
	});
});
