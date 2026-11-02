import { afterEach, expect, it, vi } from 'vitest';

import {
	OperationRegistry,
	OperationScope,
	settleOperation
} from './lifecycle.js';

afterEach(() => {
	vi.useRealTimers();
});

it('publishes a distinct cleanup deadline before abort listeners run', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);

	const lifetime = new AbortController();
	const scope = new OperationScope(
		identity,
		lifetime.signal,
		{ timeoutMs: 20 },
		120_000,
		{ cancellationGraceMs: 80, disposalTimeoutMs: 100 }
	);
	const forwarded = { ...scope.context };
	let observed: number | undefined;

	scope.context.signal.addEventListener('abort', () => {
		observed = forwarded.cleanup.deadline;
	});
	await vi.advanceTimersByTimeAsync(20);
	expect({ execution: forwarded.deadline, cleanup: observed }).toStrictEqual({
		execution: 1020,
		cleanup: 1100
	});
	scope.dispose();
});

it('uses the configured grace and never renews it for another settlement', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);

	const lifetime = new AbortController();
	const scope = new OperationScope(identity, lifetime.signal, {}, 120_000, {
		cancellationGraceMs: 40,
		disposalTimeoutMs: 100
	});
	const operation = Promise.withResolvers<string>();
	let result: unknown;

	async function recordSettlement() {
		result = await settleOperation(scope, operation.promise);
	}

	const pending = recordSettlement();

	try {
		lifetime.abort();
		await vi.advanceTimersByTimeAsync(40);
		expect(result).toStrictEqual({ kind: 'abandoned' });

		const repeated = settleOperation(scope, operation.promise);

		await vi.advanceTimersByTimeAsync(0);
		expect(await repeated).toStrictEqual({ kind: 'abandoned' });
	} finally {
		operation.resolve('stopped');
		await pending;
		scope.dispose();
	}
});

it('accepts confirmed cleanup that takes longer than the default grace', async () => {
	vi.useFakeTimers();

	const lifetime = new AbortController();
	const scope = new OperationScope(identity, lifetime.signal, {}, 120_000, {
		cancellationGraceMs: 8000,
		disposalTimeoutMs: 10_000
	});
	const operation = Promise.withResolvers<string>();
	const pending = settleOperation(scope, operation.promise);

	lifetime.abort();
	await vi.advanceTimersByTimeAsync(6000);
	operation.resolve('confirmed');
	expect(await pending).toStrictEqual({ kind: 'resolved', value: 'confirmed' });
	scope.dispose();
});

const identity = {
	operation: 'exec',
	providerId: 'fixture',
	backendId: 'backend'
} as const;

it('composes caller cancellation and lifetime with a stable first cause', () => {
	const caller = new AbortController();
	const lifetime = new AbortController();
	const scope = new OperationScope(
		identity,
		lifetime.signal,
		{ signal: caller.signal },
		120_000
	);

	caller.abort();
	lifetime.abort();

	expect(scope.cancellationError('confirmed')).toMatchObject({
		sandboxErrorVersion: 1,
		...identity,
		name: 'SandboxCancelledError',
		reason: 'caller',
		completion: 'confirmed'
	});
	expect(scope.context.signal.aborted).toBe(true);
	scope.dispose();
});

it('rejects already-aborted work before provider invocation', () => {
	const caller = new AbortController();

	caller.abort();

	const scope = new OperationScope(
		identity,
		new AbortController().signal,
		{ signal: caller.signal },
		120_000
	);

	expect(() => {
		scope.check();
	}).toThrow(
		expect.objectContaining({
			...identity,
			name: 'SandboxCancelledError',
			reason: 'caller',
			completion: 'not-started'
		})
	);
	scope.dispose();
});

it('uses milliseconds and removes its timer when finished', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);

	const scope = new OperationScope(
		identity,
		new AbortController().signal,
		{ timeoutMs: 20 },
		120_000
	);

	expect(scope.context.deadline).toBe(1020);
	await vi.advanceTimersByTimeAsync(20);
	expect(scope.cancellationError('confirmed')).toMatchObject({
		sandboxErrorVersion: 1,
		...identity,
		name: 'SandboxTimeoutError',
		reason: 'deadline',
		completion: 'confirmed'
	});
	scope.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it.each([0, -1, NaN, Infinity])(
	'rejects invalid deadlines: %s',
	(timeoutMs) => {
		expect(
			() =>
				new OperationScope(
					identity,
					new AbortController().signal,
					{ timeoutMs },
					120_000
				)
		).toThrow(expect.objectContaining({ name: 'InvalidSandboxRequestError' }));
	}
);

it('waits for an acknowledgement after cancellation', async () => {
	vi.useFakeTimers();

	const lifetime = new AbortController();
	const scope = new OperationScope(identity, lifetime.signal, {}, 120_000);
	const operation = Promise.withResolvers<string>();
	const result = settleOperation(scope, operation.promise);

	lifetime.abort();
	await vi.advanceTimersByTimeAsync(1000);
	operation.resolve('stopped');

	expect(await result).toStrictEqual({ kind: 'resolved', value: 'stopped' });
	scope.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it('bounds an unresponsive cancellation and observes a later rejection', async () => {
	vi.useFakeTimers();

	const lifetime = new AbortController();
	const scope = new OperationScope(identity, lifetime.signal, {}, 120_000);
	const operation = Promise.withResolvers<string>();
	const result = settleOperation(scope, operation.promise);

	lifetime.abort();
	await vi.advanceTimersByTimeAsync(5000);

	expect(await result).toStrictEqual({ kind: 'abandoned' });
	scope.dispose();
	operation.reject(new Error('late provider failure'));
	await Promise.resolve();
	expect(vi.getTimerCount()).toBe(0);
});

it('keeps elapsed timeouts stable when the wall clock changes', async () => {
	vi.useFakeTimers();
	vi.setSystemTime(1000);

	const scope = new OperationScope(
		identity,
		new AbortController().signal,
		{ timeoutMs: 20 },
		120_000
	);

	vi.setSystemTime(-1000);
	await vi.advanceTimersByTimeAsync(20);
	expect({
		deadline: scope.context.deadline,
		reason: scope.reason
	}).toStrictEqual({ deadline: 1020, reason: 'deadline' });
	scope.dispose();
});

it('supports deadlines beyond one native timer interval', async () => {
	vi.useFakeTimers();

	const scope = new OperationScope(
		identity,
		new AbortController().signal,
		{ timeoutMs: 2_147_483_650 },
		120_000
	);

	await vi.advanceTimersByTimeAsync(2_147_483_647);
	expect(scope.reason).toBeUndefined();
	await vi.advanceTimersByTimeAsync(3);
	expect(scope.reason).toBe('deadline');
	scope.dispose();
	expect(vi.getTimerCount()).toBe(0);
});

it('drains all registered work and releases scopes on rejection', async () => {
	vi.useFakeTimers();

	const registry = new OperationRegistry();
	const first = Promise.withResolvers<string>();
	const second = Promise.withResolvers<string>();
	const scopes = [first, second].map((gate) =>
		registry.run(
			new OperationScope(identity, new AbortController().signal, {}, 120_000),
			() => gate.promise
		)
	);
	let isDrained = false;

	async function drain() {
		await registry.drain();
		isDrained = true;
	}

	const draining = drain();

	first.resolve('first');
	expect(await scopes[0]).toBe('first');
	expect(isDrained).toBe(false);

	const cause = new Error('provider failed');
	const rejected = expect(scopes[1]).rejects.toBe(cause);

	second.reject(cause);
	await rejected;
	await draining;
	expect({ isDrained, timers: vi.getTimerCount() }).toStrictEqual({
		isDrained: true,
		timers: 0
	});
});

it('checks elapsed time before the deadline timer can dispatch', () => {
	let now = 0;
	const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
	const scope = new OperationScope(
		identity,
		new AbortController().signal,
		{ timeoutMs: 5 },
		120_000
	);

	try {
		now = 100;
		expect(() => {
			scope.check();
		}).toThrow(
			expect.objectContaining({
				name: 'SandboxTimeoutError',
				completion: 'not-started'
			})
		);
		expect({
			reason: scope.reason,
			isAborted: scope.context.signal.aborted
		}).toStrictEqual({ reason: 'deadline', isAborted: true });
	} finally {
		scope.dispose();
		clock.mockRestore();
	}
});

it.each(['resolved', 'rejected'] as const)(
	'rejects a %s cleanup acknowledgement after elapsed grace before timers dispatch',
	async (kind) => {
		vi.useFakeTimers();

		let now = 0;
		const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
		const lifetime = new AbortController();
		const scope = new OperationScope(identity, lifetime.signal, {}, 120_000, {
			cancellationGraceMs: 50,
			disposalTimeoutMs: 100
		});
		const operation = Promise.withResolvers<string>();
		const result = settleOperation(scope, operation.promise);

		try {
			lifetime.abort();
			await vi.advanceTimersByTimeAsync(0);
			now = 100;

			switch (kind) {
				case 'resolved': {
					operation.resolve('stopped');

					break;
				}

				case 'rejected': {
					operation.reject(new Error('Cleanup failed late.'));

					break;
				}
			}

			expect(await result).toStrictEqual({ kind: 'abandoned' });
		} finally {
			scope.dispose();
			clock.mockRestore();
		}
	}
);
