import { afterEach, expect, it, vi } from 'vitest';

import { validateBackend } from './backend-validation.js';
import type {
	CancellationReason,
	SandboxBackend,
	SandboxErrorInfo
} from './contracts.js';
import { SandboxPathNotFoundError, SandboxTransportError } from './errors.js';
import type { BackendOwner } from './execution.js';
import { executeProcess } from './execution.js';
import { OperationRegistry } from './lifecycle.js';
import { snapshotProcessOptions } from './process-input.js';

afterEach(() => {
	vi.useRealTimers();
});

function fixture(
	exec: (...arguments_: Parameters<SandboxBackend['exec']>) => Promise<unknown>
) {
	const lifetime = new AbortController();
	const failures: SandboxErrorInfo[] = [];
	const metadata = {
		id: 'backend',
		workspace: {
			root: '/target',
			pathFlavor: 'posix',
			relationship: 'remote',
			description: 'Test fixture.'
		},
		capabilities: {
			operations: ['exec'],
			shells: ['sh']
		},
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		},
		policyDescription: 'Test fixture.',
		recovery: { kind: 'none' },
		exec,
		dispose: () => Promise.resolve()
	} satisfies Omit<SandboxBackend, 'exec' | 'dispose'> & {
		readonly exec: typeof exec;
		readonly dispose: () => Promise<void>;
	};

	const owner: BackendOwner = {
		identity: { providerId: 'fixture', backendId: 'backend' },
		lifetime: lifetime.signal,
		operations: new OperationRegistry(),
		assertLive() {
			if (failures[0] !== undefined) {
				throw failures[0];
			}
		},
		markUnhealthy: (failure) => {
			failures.push(failure);
		},
		backend: validateBackend(
			metadata,
			{
				id: 'fixture',
				label: 'Fixture',
				capabilities: metadata.capabilities,
				policies: {
					workspaceAccess: ['read-write'],
					filesystemScope: ['provider-default'],
					networkAccess: ['provider-default']
				}
			},
			metadata.policy
		)
	};

	return { owner, lifetime, failures };
}

async function cancel(
	reason: CancellationReason,
	caller: AbortController,
	lifetime: AbortController
): Promise<void> {
	switch (reason) {
		case 'caller': {
			caller.abort();

			return;
		}

		case 'shutdown': {
			lifetime.abort();

			return;
		}

		case 'deadline': {
			await vi.advanceTimersByTimeAsync(20);

			return;
		}

		case 'output': {
			return;
		}
	}
}

const request = {
	kind: 'argv',
	executable: 'program',
	args: ['first', 'two words']
} as const;

it('streams independent bytes, captures a combined bound and drains excess output', async () => {
	const delivered: { stream: string; bytes: number[] }[] = [];
	const { owner } = fixture((_request, context) => {
		const bytes = new Uint8Array([1, 2, 3]);

		context.onOutput({ stream: 'stdout', data: bytes });
		bytes.fill(9);
		context.onOutput({ stream: 'stderr', data: new Uint8Array([4, 5, 6]) });
		context.onOutput({ stream: 'stdout', data: new Uint8Array([7]) });

		return Promise.resolve({ kind: 'exited', exit: { kind: 'code', code: 7 } });
	});
	const result = await executeProcess(owner, request, {
		maxCaptureBytes: 4,
		onOutput(output) {
			delivered.push({ stream: output.stream, bytes: [...output.data] });
			output.data.fill(0);
		}
	});

	expect({ ...result, durationMs: 0 }).toStrictEqual({
		exit: { kind: 'code', code: 7 },
		stdout: new Uint8Array([1, 2, 3]),
		stderr: new Uint8Array([4]),
		omittedBytes: { stdout: 1, stderr: 2 },
		durationMs: 0
	});
	expect(result.durationMs).toBeGreaterThanOrEqual(0);
	expect(delivered).toStrictEqual([
		{ stream: 'stdout', bytes: [1, 2, 3] },
		{ stream: 'stderr', bytes: [4, 5, 6] },
		{ stream: 'stdout', bytes: [7] }
	]);
});

it('snapshots arguments and environment before invoking a provider', async () => {
	const arguments_ = ['original'];
	const environment = { KEY: 'original' };
	const received: unknown[] = [];
	const { owner } = fixture(async (input) => {
		await Promise.resolve();
		received.push(input);

		return { kind: 'exited', exit: { kind: 'code', code: 0 } };
	});
	const result = executeProcess(owner, {
		kind: 'argv',
		executable: 'program',
		args: arguments_,
		env: environment
	});

	arguments_[0] = 'changed';
	environment.KEY = 'changed';
	await result;

	expect(received).toStrictEqual([
		{
			kind: 'argv',
			executable: 'program',
			args: ['original'],
			env: { KEY: 'original' }
		}
	]);
});

it.each(['caller', 'shutdown', 'deadline', 'output'] as const)(
	'requires termination confirmation for %s cancellation',
	async (reason) => {
		vi.useFakeTimers();

		const caller = new AbortController();
		let calls = 0;
		const { owner, lifetime, failures } = fixture((_input, context) => {
			calls++;

			return new Promise((resolve) => {
				context.signal.addEventListener(
					'abort',
					() => {
						resolve({ kind: 'cancelled', termination: 'confirmed' });
					},
					{ once: true }
				);

				if (reason === 'output') {
					context.onOutput({ stream: 'stdout', data: new Uint8Array([1]) });
				}
			});
		});
		const result = executeProcess(owner, request, {
			signal: caller.signal,
			timeoutMs: 20,
			onOutput() {
				throw new Error('consumer callback failure');
			}
		});
		const rejected = expect(result).rejects.toMatchObject({
			name:
				reason === 'deadline'
					? 'SandboxTimeoutError'
					: reason === 'output'
						? 'SandboxOutputCallbackError'
						: 'SandboxCancelledError',
			operation: 'exec',
			providerId: 'fixture',
			backendId: 'backend',
			reason,
			completion: 'confirmed'
		});

		await cancel(reason, caller, lifetime);
		await rejected;
		expect({ calls, failures }).toStrictEqual({ calls: 1, failures: [] });
	}
);

it.each(['caller', 'shutdown', 'deadline', 'output'] as const)(
	'quarantines an unresponsive backend after %s cancellation and suppresses late output',
	async (reason) => {
		vi.useFakeTimers();

		const caller = new AbortController();
		const chunks: number[] = [];
		let emit: (() => void) | undefined;
		let calls = 0;
		const { owner, lifetime, failures } = fixture((_input, context) => {
			calls++;

			emit = () => {
				context.onOutput({ stream: 'stdout', data: new Uint8Array([1]) });
			};

			if (reason === 'output') {
				emit();
			}

			return Promise.withResolvers<never>().promise;
		});
		const result = executeProcess(owner, request, {
			signal: caller.signal,
			timeoutMs: 20,
			onOutput: (output) => {
				if (reason === 'output') {
					throw new Error('consumer callback failed');
				}

				chunks.push(...output.data);
			}
		});
		const rejected = expect(result).rejects.toMatchObject({
			name: 'UnconfirmedSandboxTerminationError',
			completion: 'unknown',
			reason
		});

		await cancel(reason, caller, lifetime);
		await vi.advanceTimersByTimeAsync(5000);
		await rejected;
		emit?.();
		await expect(executeProcess(owner, request)).rejects.toMatchObject({
			name: 'UnconfirmedSandboxTerminationError'
		});
		expect({
			calls,
			names: failures.map((error) => error.name),
			chunks
		}).toStrictEqual({
			calls: 1,
			names: ['UnconfirmedSandboxTerminationError'],
			chunks: []
		});
	}
);

it('rejects a pre-aborted call and unsupported shell before invoking a provider', async () => {
	let calls = 0;
	const { owner } = fixture(() => {
		calls++;

		return Promise.resolve({ kind: 'exited', exit: { kind: 'code', code: 0 } });
	});
	const caller = new AbortController();

	caller.abort();
	await expect(
		executeProcess(owner, request, { signal: caller.signal })
	).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'not-started'
	});
	await expect(
		executeProcess(owner, {
			kind: 'shell',
			command: 'echo test',
			dialect: 'bash'
		})
	).rejects.toMatchObject({ name: 'UnsupportedSandboxCapabilityError' });
	expect(calls).toBe(0);
});

it.each([
	{ kind: 'cancelled', termination: 'unconfirmed' },
	{ kind: 'cancelled', termination: 'confirmed' },
	{ kind: 'exited', exit: { kind: 'code', code: 0.5 } },
	...[undefined, 0, -1, 1.5, NaN, Infinity].map((signalNumber) => ({
		kind: 'exited',
		exit: { kind: 'signal', signal: 'SIGTERM', signalNumber }
	})),
	{ kind: 'exited', exit: { kind: 'signal', signal: '', signalNumber: 15 } },
	undefined
])(
	'quarantines invalid or uncertain provider outcomes: %j',
	async (outcome) => {
		const { owner, failures } = fixture(() => Promise.resolve(outcome));

		await expect(executeProcess(owner, request)).rejects.toMatchObject({
			completion: 'unknown',
			operation: 'exec'
		});
		expect(failures.map((error) => error.name)).toStrictEqual([
			outcome?.kind === 'cancelled' &&
			'termination' in outcome &&
			outcome.termination === 'unconfirmed'
				? 'UnconfirmedSandboxTerminationError'
				: 'SandboxTransportError'
		]);
	}
);

it.each([
	new Error('lost connection'),
	new SandboxTransportError({ operation: 'exec' })
])(
	'quarantines transport failures without replaying the operation',
	async (cause) => {
		let calls = 0;
		const { owner, failures } = fixture(() => {
			calls++;

			return Promise.reject(cause);
		});

		await expect(executeProcess(owner, request)).rejects.toMatchObject({
			name: 'SandboxTransportError',
			completion: 'unknown'
		});
		await expect(executeProcess(owner, request)).rejects.toBe(failures[0]);
		expect(calls).toBe(1);
	}
);

it('preserves known target failures and allows later calls', async () => {
	let calls = 0;
	const { owner, failures } = fixture(() => {
		calls++;

		if (calls === 1) {
			throw new SandboxPathNotFoundError({ operation: 'exec' });
		}

		return Promise.resolve({
			kind: 'exited',
			exit: { kind: 'signal', signal: 'SIGTERM', signalNumber: 15 }
		});
	});

	await expect(executeProcess(owner, request)).rejects.toMatchObject({
		name: 'SandboxPathNotFoundError',
		providerId: 'fixture',
		backendId: 'backend'
	});

	const result = await executeProcess(owner, request);

	expect({ ...result, durationMs: 0, calls, failures }).toStrictEqual({
		exit: { kind: 'signal', signal: 'SIGTERM', signalNumber: 15 },
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
		omittedBytes: { stdout: 0, stderr: 0 },
		durationMs: 0,
		calls: 2,
		failures: []
	});
});

it.each([0, 4])(
	'drains streamed bytes after a %s byte capture limit',
	async (maxCaptureBytes) => {
		let delivered = 0;
		const { owner } = fixture((_input, context) => {
			for (let index = 0; index < 4000; index++) {
				context.onOutput({
					stream: index % 2 === 0 ? 'stdout' : 'stderr',
					data: new Uint8Array([1])
				});
			}

			return Promise.resolve({
				kind: 'exited',
				exit: { kind: 'code', code: 0 }
			});
		});
		const result = await executeProcess(owner, request, {
			maxCaptureBytes,
			onOutput(output) {
				delivered += output.data.byteLength;
			}
		});

		expect({ ...result, durationMs: 0, delivered }).toStrictEqual({
			exit: { kind: 'code', code: 0 },
			stdout: new Uint8Array(maxCaptureBytes / 2).fill(1),
			stderr: new Uint8Array(maxCaptureBytes / 2).fill(1),
			omittedBytes: {
				stdout: 2000 - maxCaptureBytes / 2,
				stderr: 2000 - maxCaptureBytes / 2
			},
			durationMs: 0,
			delivered: 4000
		});
	}
);

it('cancels and observes an invalid asynchronous output callback', async () => {
	const { owner, failures } = fixture(
		(_input, context) =>
			new Promise((resolve) => {
				context.signal.addEventListener(
					'abort',
					() => {
						resolve({ kind: 'cancelled', termination: 'confirmed' });
					},
					{ once: true }
				);
				context.onOutput({ stream: 'stdout', data: new Uint8Array([1]) });
			})
	);
	const options = snapshotProcessOptions({
		onOutput: () => Promise.reject(new Error('asynchronous callback failed'))
	});

	await expect(executeProcess(owner, request, options)).rejects.toMatchObject({
		name: 'SandboxOutputCallbackError',
		completion: 'confirmed',
		cause: { name: 'InvalidSandboxRequestError' }
	});
	expect(failures).toStrictEqual([]);
});

it.each(['code', 'signal'] as const)(
	'snapshots provider-owned %s exits and ignores extra metadata',
	async (kind) => {
		const exit =
			kind === 'code'
				? { kind, code: 0, privateValue: 'secret' }
				: { kind, signal: 'SIGTERM', signalNumber: 15, privateValue: 'secret' };
		const expected =
			kind === 'code'
				? { kind, code: 0 }
				: { kind, signal: 'SIGTERM', signalNumber: 15 };
		const { owner } = fixture(() => Promise.resolve({ kind: 'exited', exit }));
		const result = await executeProcess(owner, request);

		if (exit.kind === 'code') {
			exit.code = 99;
		} else {
			exit.signal = 'SIGKILL';
			exit.signalNumber = 9;
		}

		expect({
			...result,
			durationMs: 0,
			isFrozen: Object.isFrozen(result),
			isExitFrozen: Object.isFrozen(result.exit),
			areCountsFrozen: Object.isFrozen(result.omittedBytes),
			sharesExit: result.exit === exit
		}).toStrictEqual({
			exit: expected,
			stdout: new Uint8Array(),
			stderr: new Uint8Array(),
			omittedBytes: { stdout: 0, stderr: 0 },
			durationMs: 0,
			isFrozen: true,
			isExitFrozen: true,
			areCountsFrozen: true,
			sharesExit: false
		});
	}
);
