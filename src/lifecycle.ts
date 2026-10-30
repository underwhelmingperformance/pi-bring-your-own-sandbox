import { randomUUID } from 'node:crypto';

import type {
	CancellationReason,
	OperationCompletion,
	RecoveryDescriptor,
	SandboxOperation,
	SandboxOperationContext,
	SandboxOperationOptions
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxCancelledError,
	SandboxOperationError,
	SandboxOutputCallbackError,
	SandboxTimeoutError
} from './errors.js';

export interface OperationIdentity {
	readonly operation: SandboxOperation;
	readonly providerId?: string;
	readonly backendId?: string;
	readonly recovery?: RecoveryDescriptor;
}

export class OperationScope {
	readonly #identity: OperationIdentity;
	readonly #expiresAt: number;
	readonly #controller = new AbortController();
	readonly #cancelled = Promise.withResolvers<CancellationReason>();
	readonly #listeners: (() => void)[] = [];
	#timer: ReturnType<typeof setTimeout> | undefined;
	#reason: CancellationReason | undefined;
	#cause: unknown;
	#isFinished = false;
	readonly context: SandboxOperationContext;

	constructor(
		identity: OperationIdentity,
		lifetime: AbortSignal,
		options: SandboxOperationOptions,
		defaultMs: number
	) {
		this.#identity = identity;
		const timeoutMs = options.timeoutMs ?? defaultMs;
		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new InvalidSandboxRequestError({
				...identity
			});
		}

		this.#expiresAt = performance.now() + timeoutMs;
		this.context = Object.freeze({
			operationId: randomUUID(),
			signal: this.#controller.signal,
			deadline: Date.now() + timeoutMs
		});
		this.#listen(lifetime, 'shutdown');
		if (options.signal !== undefined) {
			this.#listen(options.signal, 'caller');
		}
		if (this.#reason === undefined) {
			this.#scheduleDeadline();
		}
	}

	#listen(signal: AbortSignal, reason: CancellationReason): void {
		if (signal.aborted) {
			this.abort(reason);
			return;
		}

		const listener = () => {
			this.abort(reason);
		};
		signal.addEventListener('abort', listener, { once: true });
		this.#listeners.push(() => {
			signal.removeEventListener('abort', listener);
		});
	}

	#scheduleDeadline(): void {
		const remaining = this.#expiresAt - performance.now();
		if (remaining <= 0) {
			this.abort('deadline');
			return;
		}

		this.#timer = setTimeout(
			() => {
				this.#scheduleDeadline();
			},
			Math.min(remaining, 2_147_483_647)
		);
	}

	get reason(): CancellationReason | undefined {
		if (this.#reason === undefined && performance.now() >= this.#expiresAt) {
			this.abort('deadline');
		}
		return this.#reason;
	}

	abort(reason: CancellationReason, cause?: unknown): void {
		if (this.#reason !== undefined || this.#isFinished) {
			return;
		}

		this.#reason = reason;
		this.#cause = cause;
		this.#controller.abort(reason);
		this.#cancelled.resolve(reason);
	}

	check(completion: OperationCompletion = 'not-started'): void {
		if (this.reason !== undefined) {
			throw this.cancellationError(completion);
		}
	}

	async whenCancelled(): Promise<{ readonly kind: 'cancelled' }> {
		await this.#cancelled.promise;
		return { kind: 'cancelled' };
	}

	cancellationError(completion: OperationCompletion) {
		switch (this.#reason) {
			case 'caller':
			case 'shutdown': {
				return new SandboxCancelledError(
					{
						...this.#identity,
						reason: this.#reason,
						completion
					},
					{ cause: this.#cause }
				);
			}
			case 'deadline': {
				return new SandboxTimeoutError({
					...this.#identity,
					completion
				});
			}
			case 'output': {
				return new SandboxOutputCallbackError(
					{
						...this.#identity,
						completion
					},
					{ cause: this.#cause }
				);
			}
			default: {
				throw new SandboxOperationError({ ...this.#identity });
			}
		}
	}

	dispose(): void {
		if (this.#isFinished) {
			return;
		}

		this.#isFinished = true;
		clearTimeout(this.#timer);
		for (const remove of this.#listeners) {
			remove();
		}
		this.#listeners.length = 0;
	}
}

export class OperationRegistry {
	readonly #active = new Set<Promise<'finished'>>();

	async run<Value>(
		scope: OperationScope,
		execute: () => Promise<Value>
	): Promise<Value> {
		const finished = Promise.withResolvers<'finished'>();
		this.#active.add(finished.promise);
		try {
			return await execute();
		} finally {
			scope.dispose();
			this.#active.delete(finished.promise);
			finished.resolve('finished');
		}
	}

	async drain(): Promise<void> {
		await Promise.allSettled(this.#active);
	}
}

export type Settlement<Value> =
	| { readonly kind: 'resolved'; readonly value: Value }
	| { readonly kind: 'rejected'; readonly error: unknown }
	| { readonly kind: 'abandoned' };

export async function observe<Value>(
	promise: Promise<Value>
): Promise<Exclude<Settlement<Value>, { kind: 'abandoned' }>> {
	try {
		return { kind: 'resolved', value: await promise };
	} catch (error) {
		return { kind: 'rejected', error };
	}
}

export async function settleOperation<Value>(
	scope: OperationScope,
	promise: Promise<Value>,
	graceMs = 5000
): Promise<Settlement<Value>> {
	const completion = observe(promise);
	const first = await Promise.race([completion, scope.whenCancelled()]);
	if (first.kind !== 'cancelled') {
		return first;
	}

	let timer: ReturnType<typeof setTimeout> | undefined;
	const limit = new Promise<{ readonly kind: 'abandoned' }>((resolve) => {
		timer = setTimeout(() => {
			resolve({ kind: 'abandoned' });
		}, graceMs);
	});

	try {
		return await Promise.race([completion, limit]);
	} finally {
		clearTimeout(timer);
	}
}
