import { expect, it } from 'vitest';

import { FakeClock } from './fixtures/clock.js';
import { HostOperations } from './host-operations.js';
import { OperationScope } from './lifecycle.js';

it.each([-1_000_000, 1_000_000])(
	'preserves the parent budget across a wall-clock jump to %s',
	async (wallTime) => {
		const clock = new FakeClock();

		const scope = new OperationScope(
			{ operation: 'stat' },
			new AbortController().signal,
			{ timeoutMs: 1000 },
			1000,
			undefined,
			clock
		);
		const operations = new HostOperations(clock);

		try {
			clock.advance(100);
			clock.wallTime = wallTime;

			await expect(
				operations.run('stat', scope.context, (context) =>
					Promise.resolve({
						result: 'target result',
						remainingMs: context.remainingMs()
					})
				)
			).resolves.toStrictEqual({ result: 'target result', remainingMs: 900 });
		} finally {
			scope.dispose();
		}
	}
);
