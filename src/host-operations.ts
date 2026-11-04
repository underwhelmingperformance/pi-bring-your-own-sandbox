import type { Clock } from './clock.js';
import { systemClock } from './clock.js';
import type { SandboxOperation, SandboxOperationContext } from './contracts.js';
import {
	isSandboxError,
	SandboxCleanupError,
	SandboxSessionClosingError
} from './errors.js';
import { hostError } from './host-error.js';
import { observe, OperationRegistry, OperationScope } from './lifecycle.js';
import { isRecord } from './validation.js';

export class HostOperations {
	readonly #clock: Clock;
	readonly #lifetime = new AbortController();
	readonly #operations = new OperationRegistry();
	#closing: Promise<void> | undefined;

	constructor(clock: Clock = systemClock) {
		this.#clock = clock;
	}

	async #dispose(context: SandboxOperationContext): Promise<void> {
		const scope = new OperationScope(
			{ operation: 'dispose', providerId: 'passthrough' },
			new AbortController().signal,
			{ signal: context.signal },
			Math.max(1, context.remainingMs()),
			undefined,
			this.#clock
		);

		try {
			const result = await Promise.race([
				observe(this.#operations.drain()),
				scope.whenCancelled()
			]);

			if (
				result.kind !== 'resolved' ||
				context.remainingMs() <= 0 ||
				scope.reason !== undefined
			) {
				throw new SandboxCleanupError({
					operation: 'dispose',
					providerId: 'passthrough'
				});
			}
		} finally {
			scope.dispose();
		}
	}

	async #finishDispose(
		context: SandboxOperationContext,
		pending: PromiseWithResolvers<undefined>
	): Promise<void> {
		try {
			await this.#dispose(context);
			pending.resolve(undefined);
		} catch (error) {
			pending.reject(error);
		}
	}

	async run<Value>(
		operation: SandboxOperation,
		context: SandboxOperationContext,
		execute: (context: SandboxOperationContext) => Promise<Value>
	): Promise<Value> {
		if (this.#closing !== undefined) {
			throw new SandboxSessionClosingError({
				operation,
				providerId: 'passthrough'
			});
		}

		const scope = new OperationScope(
			{ operation, providerId: 'passthrough' },
			this.#lifetime.signal,
			{ signal: context.signal },
			Math.max(1, context.remainingMs()),
			undefined,
			this.#clock
		);

		if (context.remainingMs() <= 0) {
			scope.abort('deadline');
		}

		return this.#operations.run(scope, async () => {
			scope.check();

			try {
				const result = await execute({
					...scope.context,
					cleanup: context.cleanup,
					reportDiagnostic: context.reportDiagnostic,
					operationId: context.operationId,
					deadline: context.deadline,
					remainingMs: context.remainingMs
				});

				if (
					scope.reason !== undefined &&
					(operation !== 'exec' ||
						(isRecord(result) &&
							result.kind === 'cancelled' &&
							result.termination === 'confirmed'))
				) {
					throw scope.cancellationError('confirmed');
				}

				return result;
			} catch (error) {
				if (
					isSandboxError(error) &&
					'completion' in error &&
					error.completion === 'unknown'
				) {
					throw error;
				}

				if (operation !== 'exec' && scope.reason !== undefined) {
					throw scope.cancellationError('confirmed');
				}

				throw hostError(error, operation);
			}
		});
	}

	dispose(context: SandboxOperationContext): Promise<void> {
		if (this.#closing !== undefined) {
			return this.#closing;
		}

		const pending = Promise.withResolvers<undefined>();

		this.#closing = pending.promise;
		this.#lifetime.abort();
		void this.#finishDispose(context, pending);

		return pending.promise;
	}
}
