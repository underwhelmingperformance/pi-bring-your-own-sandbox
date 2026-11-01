import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessOutput,
	ProcessRequest,
	Sandbox,
	SandboxClient,
	SandboxContext,
	SandboxHost
} from './contracts.js';
import { SandboxCancelledError, SandboxTransportError } from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { observe } from './lifecycle.js';
import type { ShellInvocation } from './sandbox-shell.js';
import { SandboxShell } from './sandbox-shell.js';

afterEach(() => {
	vi.useRealTimers();
});

class FakeClient implements Pick<SandboxClient, 'getSandbox'> {
	readonly #sandbox: Sandbox;
	readonly #acquire:
		((signal: AbortSignal | undefined) => Promise<void>) | undefined;
	readonly signals: (AbortSignal | undefined)[] = [];

	constructor(
		sandbox: Sandbox,
		acquire?: (signal: AbortSignal | undefined) => Promise<void>
	) {
		this.#sandbox = sandbox;
		this.#acquire = acquire;
	}

	async getSandbox(
		_pi: SandboxHost,
		_context: SandboxContext,
		options?: Parameters<SandboxClient['getSandbox']>[2]
	): Promise<Sandbox> {
		this.signals.push(options?.signal);
		await this.#acquire?.(options?.signal);

		return this.#sandbox;
	}
}

function fixture(
	acquire?: (signal: AbortSignal | undefined) => Promise<void>,
	run?: (context: BackendProcessContext) => Promise<BackendProcessOutcome>
) {
	const memory = new MemoryBackend();
	const calls: ProcessRequest[] = [];
	const backend = {
		id: memory.id,
		workspace: { ...memory.workspace, root: '/work' },
		capabilities: {
			operations: ['exec'] as const,
			shells: ['bash', 'powershell'] as const
		},
		policy: memory.policy,
		policyDescription: memory.policyDescription,
		recovery: memory.recovery,
		exec(request: ProcessRequest, context: BackendProcessContext) {
			calls.push(request);
			context.onOutput({
				stream: 'stdout',
				data: new TextEncoder().encode('target output')
			});

			return (
				run?.(context) ??
				Promise.resolve({
					kind: 'exited' as const,
					exit: { kind: 'code' as const, code: 7 }
				})
			);
		},
		dispose: memory.dispose.bind(memory)
	};
	const owner = new TestBackendOwner(backend);
	const sandbox = createSandbox(owner);
	const client = new FakeClient(sandbox, acquire);
	const shell = new SandboxShell(client);
	const output: ProcessOutput[] = [];
	const pi: SandboxHost = {
		events: createEventBus(),
		sendMessage() {
			throw new Error('Unexpected diagnostic message.');
		},
		appendEntry() {
			throw new Error('Unexpected diagnostic entry.');
		},
		on() {
			throw new Error('Unexpected lifecycle registration');
		}
	};
	const context: SandboxContext = {
		cwd: '/work/project',
		isProjectTrusted: () => false,
		sessionManager: SessionManager.inMemory('/work/project')
	};
	const invocation: ShellInvocation = {
		dialect: 'bash',
		command: 'printf target',
		onOutput(chunk) {
			output.push(chunk);
		}
	};

	return { shell, pi, context, invocation, calls, output, client, owner };
}

it('routes shell text to the target root without inheriting host cwd or environment', async () => {
	const { shell, pi, context, invocation, calls, output } = fixture();
	const result = await shell.execute(pi, context, invocation);

	expect({
		calls,
		output,
		exit: result.exit,
		stdout: result.stdout
	}).toStrictEqual({
		calls: [
			{ kind: 'shell', dialect: 'bash', command: 'printf target', cwd: '/work' }
		],
		output: [
			{ stream: 'stdout', data: new TextEncoder().encode('target output') }
		],
		exit: { kind: 'code', code: 7 },
		stdout: new Uint8Array()
	});
});

it.each([0, -1, NaN, Infinity, 2_147_484])(
	'rejects invalid timeout %s before acquiring a backend',
	async (timeoutSeconds) => {
		const { shell, pi, context, invocation, client } = fixture();

		await expect(
			shell.execute(pi, context, { ...invocation, timeoutSeconds })
		).rejects.toMatchObject({
			name: 'InvalidSandboxRequestError',
			operation: 'exec'
		});
		expect(client.signals).toStrictEqual([]);
	}
);

it('does not execute when a caller cancels during acquisition', async () => {
	const gate = Promise.withResolvers<'ready'>();
	const controller = new AbortController();
	const { shell, pi, context, invocation, calls } = fixture(async (signal) => {
		await gate.promise;

		if (signal?.aborted === true) {
			throw new SandboxCancelledError({
				operation: 'acquire',
				reason: 'caller',
				completion: 'not-started'
			});
		}
	});
	const running = shell.execute(pi, context, {
		...invocation,
		signal: controller.signal
	});
	const rejected = expect(running).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'not-started'
	});

	controller.abort();
	gate.resolve('ready');
	await rejected;
	expect(calls).toStrictEqual([]);
});

it('includes acquisition in an explicit timeout and never starts an expired command', async () => {
	vi.useFakeTimers();

	const gate = Promise.withResolvers<'ready'>();
	const { shell, pi, context, invocation, calls } = fixture(async () => {
		await gate.promise;
	});
	const running = shell.execute(pi, context, {
		...invocation,
		timeoutSeconds: 0.01
	});
	const rejected = expect(running).rejects.toMatchObject({
		name: 'SandboxTimeoutError',
		completion: 'not-started'
	});

	await vi.advanceTimersByTimeAsync(10);
	gate.resolve('ready');
	await rejected;
	expect(calls).toStrictEqual([]);
});

it('preserves backend identity when an explicit deadline stops a running command', async () => {
	vi.useFakeTimers();

	const started = Promise.withResolvers<'started'>();
	const { shell, pi, context, invocation, calls } = fixture(
		undefined,
		async (operation) => {
			started.resolve('started');
			await new Promise<undefined>((resolve) => {
				operation.signal.addEventListener(
					'abort',
					() => {
						resolve(undefined);
					},
					{ once: true }
				);
			});

			return { kind: 'cancelled', termination: 'confirmed' };
		}
	);
	const running = shell.execute(pi, context, {
		...invocation,
		timeoutSeconds: 0.01
	});
	const observed = observe(running);

	await started.promise;
	await vi.advanceTimersByTimeAsync(10);
	expect(await observed).toMatchObject({
		kind: 'rejected',
		error: {
			name: 'SandboxTimeoutError',
			operation: 'exec',
			completion: 'confirmed',
			providerId: 'fixture',
			backendId: 'memory'
		}
	});
	expect(calls).toStrictEqual([
		{ kind: 'shell', dialect: 'bash', command: 'printf target', cwd: '/work' }
	]);
});

it('rejects invalid command text before acquiring a backend', async () => {
	const { shell, pi, context, invocation, client } = fixture();

	await expect(
		shell.execute(pi, context, { ...invocation, command: 'invalid\0command' })
	).rejects.toMatchObject({
		name: 'InvalidSandboxRequestError',
		operation: 'exec'
	});
	expect(client.signals).toStrictEqual([]);
});

it.each([
	{ kind: 'unconfirmed', source: 'deadline' },
	{ kind: 'transport', source: 'deadline' },
	{ kind: 'unconfirmed', source: 'caller' },
	{ kind: 'transport', source: 'caller' }
] as const)(
	'preserves $source and unknown completion after $kind termination',
	async ({ kind, source }) => {
		vi.useFakeTimers();

		const started = Promise.withResolvers<undefined>();
		const controller = new AbortController();
		const { shell, pi, context, invocation, owner } = fixture(
			undefined,
			async (operation) => {
				started.resolve(undefined);
				await new Promise<undefined>((resolve) => {
					operation.signal.addEventListener(
						'abort',
						() => {
							resolve(undefined);
						},
						{ once: true }
					);
				});

				if (kind === 'transport') {
					throw new SandboxTransportError({ operation: 'exec' });
				}

				return { kind: 'cancelled', termination: 'unconfirmed' };
			}
		);
		const running = observe(
			shell.execute(pi, context, {
				...invocation,
				signal: controller.signal,
				timeoutSeconds: 0.01
			})
		);

		await started.promise;

		if (source === 'caller') {
			controller.abort();
		}

		await vi.advanceTimersByTimeAsync(10);
		expect(await running).toMatchObject({
			kind: 'rejected',
			error: {
				name:
					kind === 'transport'
						? 'SandboxTransportError'
						: 'UnconfirmedSandboxTerminationError',
				operation: 'exec',
				reason: source,
				completion: 'unknown',
				providerId: 'fixture',
				backendId: 'memory'
			}
		});
		expect(
			owner.failures.map((failure) => ({
				name: failure.name,
				reason: 'reason' in failure ? failure.reason : undefined
			}))
		).toStrictEqual([
			{
				name:
					kind === 'transport'
						? 'SandboxTransportError'
						: 'UnconfirmedSandboxTerminationError',
				reason: source
			}
		]);
	}
);
