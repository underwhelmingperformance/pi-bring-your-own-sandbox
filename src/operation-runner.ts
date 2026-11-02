import type {
	SandboxOperation,
	SandboxOperationContext,
	SandboxOperationOptions
} from './contracts.js';
import {
	isSandboxError,
	rehydrateSandboxError,
	SandboxTransportError,
	UnconfirmedSandboxTerminationError
} from './errors.js';
import type { BackendOwner } from './execution.js';
import { observe, OperationScope, settleOperation } from './lifecycle.js';
import type { MutationQueue } from './mutation-queue.js';

async function invoke<Value>(
	owner: BackendOwner,
	operation: SandboxOperation,
	scope: OperationScope,
	execute: (
		context: SandboxOperationContext,
		check: () => void
	) => Promise<Value>
): Promise<Value> {
	const result = await settleOperation(
		scope,
		Promise.try(() =>
			execute(scope.context, () => {
				scope.check('confirmed');
			})
		)
	);
	const context = {
		...owner.identity,
		operation,
		...(scope.reason !== undefined && { reason: scope.reason })
	};

	if (result.kind === 'abandoned') {
		const error = new UnconfirmedSandboxTerminationError(context);

		owner.markUnhealthy(error);

		throw error;
	}

	if (result.kind === 'rejected') {
		if (isSandboxError(result.error)) {
			const error = result.error;

			if (!('completion' in error) || error.completion !== 'unknown') {
				if (scope.reason === undefined) {
					throw rehydrateSandboxError(error, { cause: error }, context);
				}

				if ('completion' in error) {
					throw scope.cancellationError(error.completion);
				}
			}
		}

		const error =
			scope.reason === undefined
				? new SandboxTransportError(context, { cause: result.error })
				: new UnconfirmedSandboxTerminationError(context, {
						cause: result.error
					});

		owner.markUnhealthy(error);

		throw error;
	}

	if (scope.reason !== undefined) {
		throw scope.cancellationError('confirmed');
	}

	return result.value;
}

export async function runOperation<Value>(
	owner: BackendOwner,
	operation: SandboxOperation,
	options: SandboxOperationOptions,
	execute: (
		context: SandboxOperationContext,
		check: () => void
	) => Promise<Value>,
	mutations?: MutationQueue
): Promise<Value> {
	owner.assertLive(operation);

	const scope = new OperationScope(
		{ ...owner.identity, operation },
		owner.lifetime,
		options,
		30_000,
		owner.cleanup
	);

	return owner.operations.run(scope, async () => {
		scope.check();

		const progress: { isStarted: boolean } = { isStarted: false };

		const start = () => {
			scope.check();
			owner.assertLive(operation);
			progress.isStarted = true;

			return invoke(owner, operation, scope, execute);
		};

		const pending =
			mutations === undefined ? Promise.try(start) : mutations.run(start);
		const completion = observe(pending);
		const first = await Promise.race([completion, scope.whenCancelled()]);

		if (!progress.isStarted && first.kind === 'cancelled') {
			throw scope.cancellationError('not-started');
		}

		const result = first.kind === 'cancelled' ? await completion : first;

		if (result.kind === 'rejected') {
			throw result.error;
		}

		return result.value;
	});
}
