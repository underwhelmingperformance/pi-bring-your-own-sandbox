import { afterEach, expect, it, vi } from 'vitest';

import { acquireOptions, checkRequirements } from './acquire-options.js';
import type { BackendProcessContext, TerminationScope } from './contracts.js';
import {
	isSandboxError,
	SandboxCancelledError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { observe } from './lifecycle.js';
import { isCapabilities } from './validation.js';

afterEach(() => {
	vi.useRealTimers();
});

const scopes = ['none', 'process-group', 'workload'] as const;

it.each(
	scopes.flatMap((effective, rank) =>
		scopes.map((required, minimum) => ({
			effective,
			required,
			satisfies: rank >= minimum
		}))
	)
)(
	'checks $effective against the required $required termination scope',
	({ effective, required, satisfies }) => {
		const backend = new MemoryBackend('exec');

		Object.assign(backend, {
			capabilities: { ...backend.capabilities, terminationScope: effective }
		});

		const sandbox = createSandbox(new TestBackendOwner(backend));
		const options = acquireOptions({ terminationScope: required });
		const check = () => {
			checkRequirements(sandbox, options);
		};

		expect(options).toStrictEqual({
			signal: undefined,
			timeoutMs: undefined,
			terminationScope: required
		});

		if (satisfies) {
			expect(check).not.toThrow();

			return;
		}

		expect(check).toThrow(UnsupportedSandboxCapabilityError);
	}
);

it.each([undefined, 'tree', 0])(
	'rejects an absent or invalid termination scope: %s',
	(terminationScope) => {
		const backend = new MemoryBackend('exec');

		expect(isCapabilities({ ...backend.capabilities, terminationScope })).toBe(
			false
		);
	}
);

it.each(['caller', 'deadline', 'shutdown', 'output'] as const)(
	'returns $0 cancellation without waiting or quarantining when termination is not guaranteed',
	async (source) => {
		vi.useFakeTimers();

		const backend = new MemoryBackend('exec');
		const completion = Promise.withResolvers<never>();
		let execution: BackendProcessContext | undefined;
		const started = Promise.withResolvers<undefined>();

		Object.assign(backend, {
			capabilities: {
				...backend.capabilities,
				terminationScope: 'none' satisfies TerminationScope
			},
			exec: (_request: unknown, context: BackendProcessContext) => {
				execution = context;
				started.resolve(undefined);

				return completion.promise;
			}
		});

		const owner = new TestBackendOwner(backend);
		const sandbox = createSandbox(owner);
		const caller = new AbortController();
		const outputFailure = new Error('The consumer stopped accepting output.');
		const running = observe(
			sandbox.exec(
				{ kind: 'argv', executable: 'wait', args: [] },
				{
					signal: caller.signal,
					timeoutMs: 50,
					onOutput() {
						throw outputFailure;
					}
				}
			)
		);
		let result: unknown;

		async function record() {
			const outcome = await running;

			result =
				outcome.kind === 'rejected' && isSandboxError(outcome.error)
					? {
							name: outcome.error.name,
							...('completion' in outcome.error && {
								completion: outcome.error.completion
							})
						}
					: outcome;
		}

		const recorded = record();

		try {
			await started.promise;

			switch (source) {
				case 'caller': {
					caller.abort();
					break;
				}

				case 'deadline': {
					await vi.advanceTimersByTimeAsync(50);
					break;
				}

				case 'shutdown': {
					owner.shutdown.abort();
					break;
				}

				case 'output': {
					execution?.onOutput({ stream: 'stdout', data: new Uint8Array([1]) });
					break;
				}
			}

			await vi.advanceTimersByTimeAsync(0);
			expect({ result, failures: owner.failures }).toStrictEqual({
				result: {
					name:
						source === 'deadline'
							? 'SandboxTimeoutError'
							: source === 'output'
								? 'SandboxOutputCallbackError'
								: 'SandboxCancelledError',
					completion: 'not-guaranteed'
				},
				failures: []
			});
			completion.reject(new Error('A late provider failure.'));
			await recorded;
			await vi.advanceTimersByTimeAsync(0);
			expect(owner.failures).toStrictEqual([]);
		} finally {
			completion.reject(new Error('Release the pending fixture.'));
			await running;
		}
	}
);

it('recognises a cancellation without a termination guarantee structurally', () => {
	const error = new SandboxCancelledError({
		operation: 'exec',
		reason: 'caller',
		completion: 'not-guaranteed'
	});

	expect(isSandboxError(error, SandboxCancelledError)).toBe(true);
});

it.each(['process-group', 'workload'] as const)(
	'quarantines a %s provider that reports no termination guarantee',
	async (terminationScope) => {
		const backend = new MemoryBackend('exec');
		const exec = vi.fn(() =>
			Promise.resolve({
				kind: 'cancelled',
				termination: 'not-guaranteed'
			} as const)
		);

		Object.assign(backend, {
			capabilities: { ...backend.capabilities, terminationScope },
			exec
		});

		const owner = new TestBackendOwner(backend);
		const sandbox = createSandbox(owner);
		const result = await observe(
			sandbox.exec({ kind: 'argv', executable: 'probe', args: [] })
		);
		const failure: unknown = expect.objectContaining({
			name: 'UnconfirmedSandboxTerminationError',
			completion: 'unknown'
		});

		expect({ result, failures: owner.failures }).toStrictEqual({
			result: { kind: 'rejected', error: failure },
			failures: [failure]
		});
	}
);
