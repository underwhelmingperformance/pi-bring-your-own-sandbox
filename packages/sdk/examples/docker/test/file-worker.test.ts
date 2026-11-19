import { expect, it, vi } from 'vitest';

import type { DockerClient } from '../src/contracts.js';
import { DockerFileWorker } from '../src/file-worker.js';
import { DockerResources } from '../src/resources.js';

import { operationContext } from './fixture.js';

it('keeps the file worker while busy and replaces it after an idle interval', async () => {
	vi.useFakeTimers();

	const calls: string[] = [];
	const entered = Promise.withResolvers<boolean>();
	const release = Promise.withResolvers<boolean>();
	const client: DockerClient = {
		async command(command) {
			const [action] = command.args;

			calls.push(action ?? '');

			if (action === 'exec') {
				entered.resolve(true);
				await release.promise;
				command.onOutput?.({ stream: 'stdout', data: Uint8Array.of(0, 255) });
			}

			return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
		}
	};
	const lifetime = new AbortController();
	const worker = new DockerFileWorker(
		new DockerResources(client, '/example.sock'),
		client,
		{ mount: 'type=volume', readOnly: false },
		'',
		lifetime.signal
	);

	try {
		const first = worker.readFile('first', operationContext());

		await entered.promise;
		await vi.advanceTimersByTimeAsync(32_000);
		expect(calls).toStrictEqual(['create', 'start', 'exec']);
		release.resolve(true);
		expect(await first).toStrictEqual(Uint8Array.of(0, 255));
		await vi.advanceTimersByTimeAsync(20_000);
		await worker.readFile('second', operationContext());
		await vi.advanceTimersByTimeAsync(20_000);
		expect(calls).toStrictEqual(['create', 'start', 'exec', 'exec']);
		await vi.advanceTimersByTimeAsync(10_000);
		await worker.readFile('third', operationContext());
		expect(calls).toStrictEqual([
			'create',
			'start',
			'exec',
			'exec',
			'rm',
			'create',
			'start',
			'exec'
		]);
	} finally {
		release.resolve(true);
		lifetime.abort();
		await worker.close();
		vi.useRealTimers();
	}
});

it('confirms an interrupted read and cancels a queued read before dispatch', async () => {
	const entered = Promise.withResolvers<boolean>();
	const removed = Promise.withResolvers<boolean>();
	const calls: string[] = [];
	const client: DockerClient = {
		async command(command) {
			const [action] = command.args;

			calls.push(action ?? '');

			if (action === 'rm') {
				removed.resolve(true);
			}

			if (action === 'exec' && !calls.includes('rm')) {
				entered.resolve(true);
				await removed.promise;

				return {
					status: 137,
					stdout: new Uint8Array(),
					stderr: new Uint8Array()
				};
			}

			return { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() };
		}
	};
	const lifetime = new AbortController();
	const worker = new DockerFileWorker(
		new DockerResources(client, '/example.sock'),
		client,
		{ mount: 'type=volume', readOnly: false },
		'',
		lifetime.signal
	);
	const active = new AbortController();
	const queued = new AbortController();

	try {
		const running = worker.readFile('active', {
			...operationContext(),
			signal: active.signal
		});
		const interrupted = expect(running).rejects.toMatchObject({
			completion: 'confirmed'
		});

		void Promise.allSettled([interrupted]);
		await entered.promise;

		const waiting = worker.readFile('queued', {
			...operationContext(),
			signal: queued.signal
		});

		queued.abort();

		const queueResult = await Promise.race([
			Promise.allSettled([waiting]),
			new Promise((resolve) => setImmediate(resolve, 'still queued'))
		]);

		active.abort();
		await interrupted;
		expect(queueResult).toMatchObject([
			{ status: 'rejected', reason: { completion: 'not-started' } }
		]);
		await worker.readFile('next', operationContext());
		expect(calls).toStrictEqual([
			'create',
			'start',
			'exec',
			'rm',
			'create',
			'start',
			'exec'
		]);
	} finally {
		active.abort();
		lifetime.abort();
		await worker.close();
	}
});

it.each([
	{ status: 40, error: 'SandboxPathNotFoundError' },
	{ status: 41, error: 'SandboxPermissionDeniedError' },
	{ status: 42, error: 'SandboxOperationError' },
	{ status: 125, error: 'SandboxTransportError' },
	{ status: 0, error: 'SandboxTransportError' }
])(
	'maps helper status $status and malformed stat output',
	async ({ status, error }) => {
		const client: DockerClient = {
			command(command) {
				const isInvoked = command.args[0] === 'exec';

				if (isInvoked) {
					command.onOutput?.({
						stream: 'stdout',
						data: Buffer.from('incomplete')
					});
				}

				return Promise.resolve({
					status: isInvoked ? status : 0,
					stdout: new Uint8Array(),
					stderr: new Uint8Array()
				});
			}
		};
		const lifetime = new AbortController();
		const resources = new DockerResources(client, '/example.sock');
		const worker = new DockerFileWorker(
			resources,
			client,
			{ mount: 'type=volume', readOnly: false },
			'',
			lifetime.signal
		);

		try {
			await expect(
				worker.stat('path', operationContext())
			).rejects.toMatchObject({
				name: error,
				operation: 'stat',
				providerId: 'example.docker',
				backendId: resources.volume
			});
		} finally {
			lifetime.abort();
			await worker.close();
		}
	}
);

it('accepts a full-size file with helper diagnostics and retries a failed idle removal', async () => {
	vi.useFakeTimers();

	const calls: string[] = [];
	const size = 16 * 1024 * 1024;
	let shouldFail = true;
	const client: DockerClient = {
		command(command) {
			const action = command.args[0] ?? '';

			calls.push(action);

			if (action === 'exec') {
				command.onOutput?.({ stream: 'stderr', data: Uint8Array.of(42) });
				command.onOutput?.({ stream: 'stdout', data: new Uint8Array(size) });
			}

			return Promise.resolve({
				status: action === 'rm' && shouldFail ? 1 : 0,
				stdout: action === 'container' ? Uint8Array.of(42) : new Uint8Array(),
				stderr: new Uint8Array()
			});
		}
	};
	const lifetime = new AbortController();
	const worker = new DockerFileWorker(
		new DockerResources(client, '/example.sock'),
		client,
		{ mount: 'type=volume', readOnly: false },
		'',
		lifetime.signal
	);

	try {
		const bytes = await worker.readFile('large', operationContext());

		expect(bytes.byteLength).toBe(size);
		await vi.advanceTimersByTimeAsync(30_000);
		shouldFail = false;
		await worker.access('large', operationContext());
		expect(calls).toStrictEqual([
			'create',
			'start',
			'exec',
			'rm',
			'container',
			'rm',
			'create',
			'start',
			'exec'
		]);
	} finally {
		lifetime.abort();
		await worker.close();
		vi.useRealTimers();
	}
});
