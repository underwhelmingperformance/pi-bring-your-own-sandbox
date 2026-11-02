import type {
	BackendProcessOutcome,
	ProcessExit,
	ProcessOptions,
	ProcessOutput,
	ProcessRequest,
	ProcessResult,
	SandboxBackend,
	SandboxCleanupBudgets,
	SandboxErrorInfo,
	SandboxOperation
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	isSandboxError,
	rehydrateSandboxError,
	SandboxTransportError,
	UnconfirmedSandboxTerminationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import type {
	OperationIdentity,
	OperationRegistry,
	Settlement
} from './lifecycle.js';
import { OperationScope, settleOperation } from './lifecycle.js';
import {
	DEFAULT_EXEC_TIMEOUT_MS,
	MAX_CAPTURE_BYTES,
	snapshotProcessOptions,
	snapshotProcessRequest
} from './process-input.js';
import type { DiagnosticReporter } from './provider-diagnostics.js';
import { processOutcomeSchema, processOutputSchema } from './result-schemas.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

export interface BackendOwner {
	readonly reportDiagnostic?: DiagnosticReporter;
	readonly cleanup?: SandboxCleanupBudgets;
	readonly identity: Omit<OperationIdentity, 'operation'>;
	readonly backend: SandboxBackend;
	readonly lifetime: AbortSignal;
	readonly operations: OperationRegistry;
	readonly assertLive: (operation: SandboxOperation) => void;
	readonly markUnhealthy: (failure: SandboxErrorInfo) => void;
}

const isOutcome = checker(processOutcomeSchema);
const isOutput = checker(processOutputSchema);

function concatenate(chunks: readonly Uint8Array[]): Uint8Array {
	const result = new Uint8Array(
		chunks.reduce((size, chunk) => size + chunk.byteLength, 0)
	);
	let offset = 0;

	for (const chunk of chunks) {
		result.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return result;
}

export function unknownCompletion(
	owner: BackendOwner,
	scope: OperationScope,
	cause?: unknown,
	errorClass:
		| typeof SandboxTransportError
		| typeof UnconfirmedSandboxTerminationError = UnconfirmedSandboxTerminationError
) {
	const context = {
		...owner.identity,
		operation: 'exec' as const,
		...(scope.reason !== undefined && { reason: scope.reason })
	};
	const failure = new errorClass(context, { cause });

	owner.markUnhealthy(failure);

	return failure;
}

function executionOutcome(
	owner: BackendOwner,
	scope: OperationScope,
	result: Settlement<BackendProcessOutcome>
): BackendProcessOutcome & { readonly kind: 'exited' } {
	if (result.kind === 'abandoned') {
		throw unknownCompletion(owner, scope);
	}

	if (result.kind === 'rejected') {
		const error = result.error;

		if (!isSandboxError(error)) {
			throw unknownCompletion(
				owner,
				scope,
				error,
				scope.reason === undefined
					? SandboxTransportError
					: UnconfirmedSandboxTerminationError
			);
		}

		if ('completion' in error && error.completion === 'unknown') {
			throw unknownCompletion(owner, scope, error, SandboxTransportError);
		}

		if (scope.reason !== undefined) {
			if ('completion' in error) {
				throw scope.cancellationError(error.completion);
			}

			throw unknownCompletion(owner, scope, error);
		}

		throw rehydrateSandboxError(
			error,
			{ cause: error },
			{ ...owner.identity, operation: 'exec' }
		);
	}

	if (!isOutcome(result.value)) {
		throw unknownCompletion(owner, scope, undefined, SandboxTransportError);
	}

	if (
		result.value.kind === 'exited' &&
		result.value.exit.kind === 'unavailable' &&
		owner.backend.capabilities.exitStatus === 'guaranteed'
	) {
		throw unknownCompletion(owner, scope, undefined, SandboxTransportError);
	}

	if (
		result.value.kind === 'cancelled' &&
		result.value.termination === 'unconfirmed'
	) {
		throw unknownCompletion(owner, scope);
	}

	if (scope.reason !== undefined) {
		throw scope.cancellationError('confirmed');
	}

	if (result.value.kind !== 'exited') {
		throw unknownCompletion(owner, scope, undefined, SandboxTransportError);
	}

	return result.value;
}

export async function executeProcess(
	owner: BackendOwner,
	request: ProcessRequest,
	input?: ProcessOptions
): Promise<ProcessResult> {
	owner.assertLive('exec');

	const snapshot = snapshotProcessRequest(request);

	if (
		!owner.backend.capabilities.processKinds.includes(snapshot.kind) ||
		(snapshot.kind === 'shell' &&
			!owner.backend.capabilities.shells.includes(snapshot.dialect))
	) {
		throw new UnsupportedSandboxCapabilityError({
			...owner.identity,
			operation: 'exec'
		});
	}

	const options = snapshotProcessOptions(input);
	const scope = new OperationScope(
		{ ...owner.identity, operation: 'exec' },
		owner.lifetime,
		options,
		DEFAULT_EXEC_TIMEOUT_MS,
		owner.cleanup
	);

	scope.setDiagnosticReporter(owner.reportDiagnostic);

	return owner.operations.run(scope, async () => {
		scope.check();
		owner.assertLive('exec');

		const stdout: Uint8Array[] = [];
		const stderr: Uint8Array[] = [];
		const omittedBytes = { stdout: 0, stderr: 0 };
		let remaining = options.maxCaptureBytes ?? MAX_CAPTURE_BYTES;
		let isDelivering = true;
		const started = performance.now();

		const onOutput = (output: ProcessOutput) => {
			if (!isDelivering || scope.reason !== undefined) {
				return;
			}

			try {
				if (!isOutput(output)) {
					throw new InvalidSandboxDeclarationError({
						...owner.identity,
						operation: 'exec'
					});
				}

				const count = Math.min(remaining, output.data.byteLength);

				if (count > 0) {
					const captured = new Uint8Array(output.data.subarray(0, count));

					(output.stream === 'stdout' ? stdout : stderr).push(captured);
				}

				remaining -= count;
				omittedBytes[output.stream] += output.data.byteLength - count;

				const returned: unknown = options.onOutput?.({
					stream: output.stream,
					data: new Uint8Array(output.data)
				});

				if (isRecord(returned) && typeof returned.then === 'function') {
					void Promise.allSettled([Promise.resolve(returned)]);

					throw new InvalidSandboxRequestError({
						...owner.identity,
						operation: 'exec'
					});
				}
			} catch (error) {
				scope.abort('output', error);
			}
		};

		try {
			const result = await settleOperation(
				scope,
				Promise.try(() =>
					owner.backend.exec(snapshot, { ...scope.context, onOutput })
				)
			);
			const outcome = executionOutcome(owner, scope, result);

			return Object.freeze({
				exit: snapshotExit(outcome.exit),
				stdout: concatenate(stdout),
				stderr: concatenate(stderr),
				omittedBytes: Object.freeze(omittedBytes),
				durationMs: Math.max(0, performance.now() - started)
			});
		} finally {
			isDelivering = false;
		}
	});
}

function snapshotExit(exit: ProcessExit): ProcessExit {
	if (exit.kind === 'unavailable') {
		return Object.freeze({ kind: 'unavailable' });
	}

	return Object.freeze(
		exit.kind === 'code'
			? { kind: 'code', code: exit.code }
			: { kind: 'signal', signal: exit.signal, signalNumber: exit.signalNumber }
	);
}
