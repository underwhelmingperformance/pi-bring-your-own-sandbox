import { afterEach, expect, it, vi } from 'vitest';

import type { SandboxBackend, SandboxWorkspace } from './contracts.js';
import { StaleSandboxHandleError } from './errors.js';
import { createSandbox } from './facade.js';
import { writeOptions } from './file-input.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { observe } from './lifecycle.js';

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
		frozen: [
			sandbox,
			sandbox.workspace,
			sandbox.capabilities,
			sandbox.policy
		].map((value) => Object.isFrozen(value))
	}).toStrictEqual({
		providerId: 'fixture',
		backendId: 'memory',
		generationId: 'generation',
		frozen: [true, true, true, true]
	});
	invalidate();
	await expect(sandbox.files.readFile('file')).rejects.toBeInstanceOf(
		StaleSandboxHandleError
	);
});

it('serialises whole text updates with writes across consumer facades', async () => {
	const { owner, backend } = fixture();

	backend.seed('file', new TextEncoder().encode('old'));

	const firstStarted = Promise.withResolvers<string>();
	const release = Promise.withResolvers<string>();
	let writes = 0;

	backend.beforeWrite = async () => {
		writes++;

		if (writes !== 1) {
			return;
		}

		firstStarted.resolve('started');
		await release.promise;
	};

	const first = createSandbox(owner);
	const second = createSandbox(owner);
	const input = new TextEncoder().encode('new');
	const write = first.files.writeFile('file', input);
	const update = second.files.updateText('file', (text) => text + '!');

	await firstStarted.promise;
	input.fill(0);
	expect(backend.calls).toStrictEqual([
		{ operation: 'writeFile', path: '/remote/project/file' }
	]);
	release.resolve('release');
	await write;
	expect(await update).toStrictEqual({ before: 'new', after: 'new!' });
	expect(backend.calls).toStrictEqual([
		{ operation: 'writeFile', path: '/remote/project/file' },
		{ operation: 'readFile', path: '/remote/project/file' },
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

it('preserves UTF-8 BOM and CRLF, and never writes after invalid input or a failed transform', async () => {
	const { owner, backend } = fixture();
	const sandbox = createSandbox(owner);

	backend.seed('text', new TextEncoder().encode('\u{FEFF}first\r\n'));
	expect(
		await sandbox.files.updateText('text', (text) => text + 'last\r\n')
	).toStrictEqual({
		before: '\u{FEFF}first\r\n',
		after: '\u{FEFF}first\r\nlast\r\n'
	});
	backend.seed('invalid', new Uint8Array([0xff]));
	await expect(
		sandbox.files.updateText('invalid', (text) => text)
	).rejects.toMatchObject({ name: 'SandboxOperationError' });
	await expect(
		sandbox.files.updateText('text', () => {
			throw new Error('transform failed');
		})
	).rejects.toMatchObject({ name: 'SandboxOperationError' });
	expect(
		backend.calls.filter((call) => call.operation === 'writeFile')
	).toStrictEqual([{ operation: 'writeFile', path: '/remote/project/text' }]);
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

function writerFixture(
	workspace: SandboxWorkspace,
	beforeMkdir?: () => Promise<void>
) {
	const template = new MemoryBackend('exec');
	const calls: { operation: 'mkdir' | 'writeFile'; path: string }[] = [];
	const backend: SandboxBackend = {
		id: 'writer',
		workspace,
		capabilities: {
			operations: ['exec', 'files.write'],
			shells: []
		},
		policy: template.policy,
		policyDescription: template.policyDescription,
		recovery: template.recovery,
		exec: template.exec.bind(template),
		dispose: template.dispose.bind(template),
		files: {
			write: {
				access: () => Promise.resolve(),
				async mkdir(filename) {
					calls.push({ operation: 'mkdir', path: filename });
					await beforeMkdir?.();
				},
				writeFile(filename) {
					calls.push({ operation: 'writeFile', path: filename });

					return Promise.resolve();
				}
			}
		}
	};
	const owner = new TestBackendOwner(backend);

	return { sandbox: createSandbox(owner), calls, owner };
}

it.each([
	{
		pathFlavor: 'posix' as const,
		root: '/target',
		filename: '/target/nested/file',
		parent: '/target/nested'
	},
	{
		pathFlavor: 'win32' as const,
		root: String.raw`D:\target`,
		filename: String.raw`D:\target\nested\file`,
		parent: String.raw`D:\target\nested`
	}
])(
	'creates target-native parents in the write queue: $pathFlavor',
	async ({ pathFlavor, root, filename, parent }) => {
		const { sandbox, calls } = writerFixture({
			root,
			pathFlavor,
			relationship: 'remote',
			description: 'Test fixture.'
		});
		const options = { createParents: true };
		const running = sandbox.files.writeFile(
			filename,
			new Uint8Array([1]),
			options
		);

		options.createParents = false;
		await running;
		expect(calls).toStrictEqual([
			{ operation: 'mkdir', path: parent },
			{ operation: 'writeFile', path: filename }
		]);
	}
);

it('does not write after cancellation during confirmed parent creation', async () => {
	const started = Promise.withResolvers<'started'>();
	const release = Promise.withResolvers<'ready'>();
	const { sandbox, calls, owner } = writerFixture(
		{
			root: '/target',
			pathFlavor: 'posix',
			relationship: 'remote',
			description: 'Test fixture.'
		},
		async () => {
			started.resolve('started');
			await release.promise;
		}
	);
	const controller = new AbortController();
	const running = observe(
		sandbox.files.writeFile('/target/file', new Uint8Array([1]), {
			createParents: true,
			signal: controller.signal
		})
	);

	await started.promise;
	controller.abort();
	release.resolve('ready');
	expect(await running).toMatchObject({
		kind: 'rejected',
		error: {
			name: 'SandboxCancelledError',
			completion: 'confirmed',
			operation: 'writeFile'
		}
	});
	expect({ calls, failures: owner.failures }).toStrictEqual({
		calls: [{ operation: 'mkdir', path: '/target' }],
		failures: []
	});
});

it.each([0, 'yes', { invalid: true }])(
	'rejects an invalid parent-creation flag: %j',
	(value) => {
		expect(() => writeOptions({ createParents: value })).toThrow(
			'The sandbox request is invalid.'
		);
	}
);

it('does not write after a synchronous transform overruns its deadline', async () => {
	let now = 0;
	const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
	const { owner, backend } = fixture();
	const sandbox = createSandbox(owner);

	backend.seed('file', new TextEncoder().encode('before'));

	try {
		await expect(
			sandbox.files.updateText(
				'file',
				() => {
					now = 100;

					return 'after';
				},
				{ timeoutMs: 5 }
			)
		).rejects.toMatchObject({
			name: 'SandboxTimeoutError',
			completion: 'confirmed'
		});

		const writes = backend.calls.filter(
			(call) => call.operation === 'writeFile'
		);

		expect({
			writes,
			contents: await sandbox.files.readFile('file')
		}).toStrictEqual({
			writes: [],
			contents: new TextEncoder().encode('before')
		});
	} finally {
		clock.mockRestore();
	}
});
