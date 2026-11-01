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
	readonly #lifetime = new AbortController();
	readonly #operations = new OperationRegistry();
	#closing: Promise<void> | undefined;

	async #dispose(context: SandboxOperationContext): Promise<void> {
		const scope = new OperationScope(
			{ operation: 'dispose', providerId: 'passthrough' },
			new AbortController().signal,
			{ signal: context.signal },
			Math.max(1, context.deadline - Date.now())
		);

		try {
			const result = await Promise.race([
				observe(this.#operations.drain()),
				scope.whenCancelled()
			]);

			if (result.kind !== 'resolved') {
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
			Math.max(1, context.deadline - Date.now())
		);

		if (context.deadline <= Date.now()) {
			scope.abort('deadline');
		}

		return this.#operations.run(scope, async () => {
			scope.check();

			try {
				const result = await execute({
					...scope.context,
					operationId: context.operationId,
					deadline: context.deadline
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
