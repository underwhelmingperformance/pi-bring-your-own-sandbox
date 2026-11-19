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
