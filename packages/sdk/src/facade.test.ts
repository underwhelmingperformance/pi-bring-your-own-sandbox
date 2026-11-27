import { afterEach, expect, it, vi } from 'vitest';

import { StaleSandboxHandleError } from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { MemoryBackend } from './fixtures/memory-backend.js';

afterEach(() => {
	vi.useRealTimers();
});

function fixture(backend = new MemoryBackend()) {
	const owner = new TestBackendOwner(backend);

	return {
		owner,
		backend,
		lifetime: owner.shutdown,
		failures: owner.failures,
		invalidate: () => {
			owner.invalidate();
		}
	};
}

it('uses target-only files and owns returned metadata and bytes', async () => {
	const { owner, backend, invalidate } = fixture();

	backend.seed('file', new Uint8Array([1, 2]));

	const sandbox = createSandbox(owner);
	const bytes = await sandbox.files.readFile('/remote/project/file');

	bytes.fill(9);
	expect(await sandbox.files.readFile('file')).toStrictEqual(
		new Uint8Array([1, 2])
	);
	expect(await sandbox.files.stat('file')).toStrictEqual({
		kind: 'file',
		size: 2
	});
	expect(await sandbox.files.listDirectory('.')).toStrictEqual([
		{ name: 'file', kind: 'file' }
	]);
	expect({
		providerId: sandbox.providerId,
		backendId: sandbox.backendId,
		generationId: sandbox.generationId,
		profile: sandbox.profile,
		fields: Object.keys(sandbox).toSorted((left, right) =>
			left.localeCompare(right)
		),
		frozen: [
			sandbox,
			sandbox.workspace,
			sandbox.profile,
			sandbox.profile.policy
		].map((value) => Object.isFrozen(value))
	}).toStrictEqual({
		providerId: 'fixture',
		backendId: 'memory',
		generationId: 'generation',
		profile: backend.profile,
		fields: [
			'backendId',
			'copy',
			'exec',
			'files',
			'generationId',
			'profile',
			'providerId',
			'search',
			'workspace'
		],
		frozen: [true, true, true, true]
	});
	invalidate();
	await expect(sandbox.files.readFile('file')).rejects.toBeInstanceOf(
		StaleSandboxHandleError
	);
});

it('rejects a retired file option without invoking the provider', async () => {
	const { owner, backend } = fixture();
	const sandbox = createSandbox(owner);
	const write: unknown = Reflect.apply(sandbox.files.writeFile, sandbox.files, [
		'file',
		new Uint8Array([1]),
		{ createParents: true }
	]);

	await expect(write).rejects.toMatchObject({
		name: 'InvalidSandboxRequestError'
	});
	expect({
		hasTransform: 'updateText' in sandbox.files,
		calls: backend.calls
	}).toStrictEqual({
		hasTransform: false,
		calls: []
	});
});

it('serialises writes and snapshots input across sandbox handles', async () => {
	const { owner, backend } = fixture();

	backend.seed('file', new TextEncoder().encode('old'));

	const firstStarted = Promise.withResolvers<string>();
	const release = Promise.withResolvers<string>();
	const previous: (Uint8Array | undefined)[] = [];

	backend.beforeWrite = async () => {
		previous.push(backend.bytes('file'));

		if (previous.length !== 1) {
			return;
		}

		firstStarted.resolve('started');
		await release.promise;
	};

	const first = createSandbox(owner);
	const second = createSandbox(owner);
	const input = new TextEncoder().encode('new');
	const write = first.files.writeFile('file', input);
	const update = second.files.writeFile(
		'file',
		new TextEncoder().encode('new!')
	);

	await firstStarted.promise;
	input.fill(0);
	expect(backend.calls).toStrictEqual([
		{ operation: 'writeFile', path: '/remote/project/file' }
	]);
	release.resolve('release');
	await write;
	await update;
	expect(previous).toStrictEqual(
		['old', 'new'].map((text) => new TextEncoder().encode(text))
	);
	expect(backend.calls).toStrictEqual([
		{ operation: 'writeFile', path: '/remote/project/file' },
		{ operation: 'writeFile', path: '/remote/project/file' }
	]);
	expect(backend.bytes('file')).toStrictEqual(new TextEncoder().encode('new!'));
});

it('cancels queued mutations before invocation without allowing later work past the active write', async () => {
	const { owner, backend } = fixture();
	const release = Promise.withResolvers<string>();
	const started = Promise.withResolvers<string>();
	let writes = 0;

	backend.beforeWrite = async () => {
		writes++;

		if (writes !== 1) {
			return;
		}

		started.resolve('started');
		await release.promise;
	};

	const sandbox = createSandbox(owner);
	const caller = new AbortController();
	const first = sandbox.files.writeFile('first', new Uint8Array([1]));

	await started.promise;

	const second = sandbox.files.writeFile('cancelled', new Uint8Array([2]), {
		signal: caller.signal
	});
	const rejected = expect(second).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'not-started'
	});
	const third = sandbox.files.writeFile('third', new Uint8Array([3]));

	caller.abort();
	await rejected;
	expect(writes).toBe(1);
	release.resolve('release');
	await first;
	await third;
	expect(backend.calls).toStrictEqual([
		{ operation: 'writeFile', path: '/remote/project/first' },
		{ operation: 'writeFile', path: '/remote/project/third' }
	]);
});

it('quarantines an unknown write before releasing the next queued mutation', async () => {
	const { owner, backend, failures } = fixture();

	backend.beforeWrite = () =>
		Promise.reject(new Error('lost write acknowledgement'));

	const sandbox = createSandbox(owner);
	const first = sandbox.files.writeFile('first', new Uint8Array([1]));
	const second = sandbox.files.writeFile('second', new Uint8Array([2]));

	await expect(first).rejects.toMatchObject({
		name: 'SandboxTransportError',
		operation: 'writeFile'
	});
	await expect(second).rejects.toBe(failures[0]);
	expect(backend.calls).toStrictEqual([
		{ operation: 'writeFile', path: '/remote/project/first' }
	]);
});

it('bounds an unconfirmed write cancellation before releasing queued work', async () => {
	vi.useFakeTimers();

	const { owner, backend, failures } = fixture();
	const started = Promise.withResolvers<string>();

	backend.beforeWrite = () => {
		started.resolve('started');

		return Promise.withResolvers<never>().promise;
	};

	const sandbox = createSandbox(owner);
	const caller = new AbortController();
	const first = sandbox.files.writeFile('first', new Uint8Array([1]), {
		signal: caller.signal
	});

	await started.promise;

	const second = sandbox.files.writeFile('second', new Uint8Array([2]));
	const rejectedFirst = expect(first).rejects.toMatchObject({
		name: 'UnconfirmedSandboxTerminationError',
		completion: 'unknown',
		reason: 'caller'
	});
	const rejectedSecond = expect(second).rejects.toMatchObject({
		name: 'UnconfirmedSandboxTerminationError'
	});

	caller.abort();
	await vi.advanceTimersByTimeAsync(5000);
	await rejectedFirst;
	await rejectedSecond;
	expect({
		calls: backend.calls,
		failures: failures.map((failure) => failure.name),
		timers: vi.getTimerCount()
	}).toStrictEqual({
		calls: [{ operation: 'writeFile', path: '/remote/project/first' }],
		failures: ['UnconfirmedSandboxTerminationError'],
		timers: 0
	});
});

it('keeps absent capability methods available and rejects without host fallback', async () => {
	const { owner, backend } = fixture(new MemoryBackend('exec'));
	const sandbox = createSandbox(owner);

	await expect(sandbox.files.readFile('/etc/hosts')).rejects.toMatchObject({
		name: 'UnsupportedSandboxCapabilityError'
	});
	await expect(sandbox.search.find({ pattern: '*' })).rejects.toMatchObject({
		name: 'UnsupportedSandboxCapabilityError'
	});
	await expect(sandbox.search.grep({ pattern: 'text' })).rejects.toMatchObject({
		name: 'UnsupportedSandboxCapabilityError'
	});
	expect(backend.calls).toStrictEqual([]);
});
