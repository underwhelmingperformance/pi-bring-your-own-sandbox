import { randomUUID } from 'node:crypto';

import {
	DEFAULT_CLEANUP_BUDGETS,
	resolveCleanupBudgets
} from './cleanup-budgets.js';
import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type {
	CancellationReason,
	OperationCompletion,
	RecoveryDescriptor,
	SandboxOperation,
	SandboxOperationContext,
	SandboxOperationOptions
} from './contracts.js';
import type { SandboxCleanupBudgets } from './contracts.js';
import type { SandboxDiagnostic } from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxCancelledError,
	SandboxOperationError,
	SandboxOutputCallbackError,
	SandboxTimeoutError
} from './errors.js';
import type { DiagnosticReporter } from './provider-diagnostics.js';

export interface OperationIdentity {
	readonly operation: SandboxOperation;
	readonly providerId?: string;
	readonly backendId?: string;
	readonly recovery?: RecoveryDescriptor;
}

export class OperationScope {
	readonly #identity: OperationIdentity;
	readonly #clock: Clock;
	readonly #expiresAt: number;
	readonly #controller = new AbortController();
	readonly #cancelled = Promise.withResolvers<CancellationReason>();
	readonly #listeners: (() => void)[] = [];
	#cancelTimer: (() => void) | undefined;
	#reason: CancellationReason | undefined;
	#cause: unknown;
	#isFinished = false;
	#cleanupBudgets: SandboxCleanupBudgets;
	#cleanupExpiresAt: number | undefined;
	#cleanupDeadline: number | undefined;
	#reportDiagnostic: DiagnosticReporter | undefined;
	readonly context: SandboxOperationContext;

	constructor(
		identity: OperationIdentity,
		lifetime: AbortSignal,
		options: SandboxOperationOptions,
		defaultMs: number,
		cleanup: SandboxCleanupBudgets = DEFAULT_CLEANUP_BUDGETS,
		clock: Clock = systemClock
	) {
		this.#identity = identity;
		this.#clock = clock;
		this.#cleanupBudgets = resolveCleanupBudgets(cleanup);

		const timeoutMs = options.timeoutMs ?? defaultMs;

		if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
			throw new InvalidSandboxRequestError({
				...identity
			});
		}

		this.#expiresAt = this.#clock.monotonicNow() + timeoutMs;

		const deadline = this.#clock.wallNow() + timeoutMs;
		const cleanupDeadline = () => this.#cleanupDeadline;

		if (identity.operation === 'dispose') {
			this.#cleanupDeadline = deadline;
			this.#cleanupExpiresAt = this.#expiresAt;
		}

		this.context = Object.freeze({
			operationId: randomUUID(),
			signal: this.#controller.signal,
			deadline,
			remainingMs: () =>
				Math.max(0, this.#expiresAt - this.#clock.monotonicNow()),
			reportDiagnostic: (diagnostic: SandboxDiagnostic) => {
				if (!this.#isFinished) {
					this.#reportDiagnostic?.(
						{ ...identity, operationId: this.context.operationId },
						diagnostic
					);
				}
			},
			cleanup: Object.freeze({
				remainingMs: () =>
					this.#cleanupExpiresAt === undefined
						? undefined
						: this.remainingCleanupMs,
				get deadline() {
					return cleanupDeadline();
				}
			})
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
		const remaining = this.#expiresAt - this.#clock.monotonicNow();

		if (remaining <= 0) {
			this.abort('deadline');

			return;
		}

		this.#cancelTimer = this.#clock.schedule(
			Math.min(remaining, 2_147_483_647),
			() => {
				this.#scheduleDeadline();
			}
		);
	}

	get remainingMs(): number {
		this.check();

		return Math.max(1, this.#expiresAt - this.#clock.monotonicNow());
	}

	get reason(): CancellationReason | undefined {
		if (
			this.#reason === undefined &&
			this.#clock.monotonicNow() >= this.#expiresAt
		) {
			this.abort('deadline');
		}

		return this.#reason;
	}

	setCleanupBudgets(cleanup: SandboxCleanupBudgets): void {
		this.check();
		this.#cleanupBudgets = resolveCleanupBudgets(cleanup);
	}

	setDiagnosticReporter(reporter: DiagnosticReporter | undefined): void {
		this.#reportDiagnostic = reporter;
	}

	scheduleCleanup(callback: () => void): () => void {
		return this.#clock.schedule(this.remainingCleanupMs, callback);
	}

	get remainingCleanupMs(): number {
		return Math.max(
			0,
			(this.#cleanupExpiresAt ?? this.#clock.monotonicNow()) -
				this.#clock.monotonicNow()
		);
	}

	abort(reason: CancellationReason, cause?: unknown): void {
		if (this.#reason !== undefined || this.#isFinished) {
			return;
		}

		this.#reason = reason;
		this.#cause = cause;
		this.#cleanupExpiresAt ??=
			this.#clock.monotonicNow() + this.#cleanupBudgets.cancellationGraceMs;
		this.#cleanupDeadline ??=
			this.#clock.wallNow() + this.#cleanupBudgets.cancellationGraceMs;
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
		this.#cancelTimer?.();

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
	promise: Promise<Value>
): Promise<Settlement<Value>> {
	const completion = observe(promise);
	const first = await Promise.race([completion, scope.whenCancelled()]);

	if (scope.reason !== undefined && scope.remainingCleanupMs <= 0) {
		return { kind: 'abandoned' };
	}

	if (first.kind !== 'cancelled') {
		return first;
	}

	let cancelTimer: (() => void) | undefined;
	const limit = new Promise<{ readonly kind: 'abandoned' }>((resolve) => {
		cancelTimer = scope.scheduleCleanup(() => {
			resolve({ kind: 'abandoned' });
		});
	});

	try {
		const result = await Promise.race([completion, limit]);

		return scope.remainingCleanupMs <= 0 ? { kind: 'abandoned' } : result;
	} finally {
		cancelTimer?.();
	}
}
