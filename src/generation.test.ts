import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { acquireOptions } from './acquire-options.js';
import { snapshotBackend } from './backend-snapshot.js';
import type { SandboxConfig } from './config.js';
import { readConfig } from './config.js';
import type {
	SandboxBackend,
	SandboxContext,
	SandboxOpenContext
} from './contracts.js';
import { InvalidSandboxConfigError, SandboxCancelledError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { SandboxGeneration } from './generation.js';
import { observe } from './lifecycle.js';
import type { ProviderServiceV1 } from './protocol.js';

afterEach(() => {
	vi.useRealTimers();
});

it.each(['providerConfig', 'policy'] as const)(
	'reports personal provenance for invalid %s',
	async (field) => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-config-generation-')
		);
		const sources = {
			agentDirectory: path.join(directory, 'agent'),
			workspace: path.join(directory, 'workspace')
		};
		const backend = new MemoryBackend();

		try {
			await mkdir(sources.agentDirectory);
			await mkdir(path.join(sources.workspace, '.pi'), { recursive: true });
			await writeFile(
				path.join(sources.agentDirectory, 'byos.json'),
				JSON.stringify({
					provider: 'fixture',
					policy:
						field === 'policy'
							? { ...backend.policy, filesystemScope: 'workspace-only' }
							: backend.policy,
					providerConfig: { valid: false }
				})
			);

			const context = {
				cwd: sources.workspace,

				sessionManager: SessionManager.inMemory(sources.workspace)
			};
			const generation = new SandboxGeneration(context, {
				readConfig: () => readConfig(sources),
				providers: () => [
					{
						id: 'fixture',
						label: 'Fixture',
						capabilities: backend.capabilities,
						policies: {
							workspaceAccess: ['read-write'],
							filesystemScope: ['provider-default'],
							networkAccess: ['provider-default']
						},
						configure() {
							throw new InvalidSandboxConfigError({ operation: 'configure' });
						}
					}
				]
			});

			try {
				await expect(generation.acquire(context)).rejects.toMatchObject({
					name:
						field === 'policy'
							? 'UnsupportedSandboxPolicyError'
							: 'InvalidSandboxConfigError',
					configurationSource: 'personal'
				});
			} finally {
				await generation.close();
			}
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it('rejects a backend returned after failed-open cleanup was acknowledged', async () => {
	const { generation, context, backend, counts } = fixture((opening) => {
		opening.confirmCleanup();

		return Promise.resolve(backend);
	});

	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError'
	});
	expect({ report: await generation.close(), counts: counts() }).toStrictEqual({
		report: { confirmed: true, failures: [], recoveries: [] },
		counts: { reads: 1, opens: 1, disposals: 1 }
	});
});

it('expires both opening callbacks after a backend is returned', async () => {
	let opening: SandboxOpenContext | undefined;
	const { generation, context, backend } = fixture((context) => {
		opening = context;

		return Promise.resolve(backend);
	});

	await generation.acquire(context);

	if (opening === undefined) {
		throw new Error('The opening context was not captured.');
	}

	const finished = opening;

	expect(() => {
		finished.confirmCleanup();
	}).toThrow();
	expect(() => {
		finished.reportRecovery({ kind: 'none' });
	}).toThrow();
	await generation.close();
});

it.each([true, false])(
	'reports failed-open cleanup acknowledgement: %s',
	async (isCleanupConfirmed) => {
		const started = Promise.withResolvers<SandboxOpenContext>();
		const { generation, context } = fixture(async (opening) => {
			opening.reportRecovery({
				kind: 'allocation',
				id: 'allocation',
				lease: 'manual',
				instructions: 'Remove allocation.'
			});
			started.resolve(opening);
			await new Promise<void>((resolve) => {
				opening.signal.addEventListener(
					'abort',
					() => {
						resolve();
					},
					{ once: true }
				);
			});

			if (isCleanupConfirmed) {
				opening.confirmCleanup();
			}

			throw new SandboxCancelledError({
				operation: 'open',
				reason: 'shutdown',
				completion: 'confirmed'
			});
		});
		const acquisition = observe(generation.acquire(context));

		await started.promise;

		const report = await generation.close();

		await acquisition;
		expect({
			confirmed: report.confirmed,
			recoveries: report.recoveries,
			failures: report.failures.map((error) => error.name)
		}).toStrictEqual({
			confirmed: isCleanupConfirmed,
			recoveries: isCleanupConfirmed
				? []
				: [
						{
							kind: 'allocation',
							id: 'allocation',
							lease: 'manual',
							instructions: 'Remove allocation.'
						}
					],
			failures: isCleanupConfirmed ? [] : ['SandboxCancelledError']
		});
	}
);

it('preserves the configuration source when recording a typed initialisation failure', async () => {
	const { context } = fixture();
	const cause = new InvalidSandboxConfigError({
		operation: 'configure',
		configurationSource: 'personal'
	});
	const generation = new SandboxGeneration(context, {
		providers: () => [],
		readConfig: () => Promise.reject(cause)
	});

	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'InvalidSandboxConfigError',
		configurationSource: 'personal',
		cause
	});
	await generation.close();
});

function fixture(
	open?: (context: SandboxOpenContext) => Promise<SandboxBackend>,
	hostWorkspace = '/host/workspace',
	configure?: () => void
) {
	const backend = new MemoryBackend();
	let opens = 0;
	let disposals = 0;
	let reads = 0;
	let isLive = true;
	const sessionManager = SessionManager.inMemory(hostWorkspace);
	const context: SandboxContext = {
		get cwd() {
			if (!isLive) {
				throw new Error('Pi context was invalidated');
			}

			return hostWorkspace;
		},
		sessionManager
	};
	const provider: ProviderServiceV1 = {
		id: 'fixture',
		label: 'Fixture',
		capabilities: backend.capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		configure: () => {
			configure?.();

			return {
				open: (_request, opening) => {
					opens++;

					return open === undefined ? Promise.resolve(backend) : open(opening);
				}
			};
		}
	};

	backend.dispose = () => {
		disposals++;

		return Promise.resolve();
	};

	const generation = new SandboxGeneration(context, {
		providers: () => [provider],
		readConfig: () => {
			reads++;

			return Promise.resolve({
				selection: {
					providerId: 'fixture',
					source: 'personal',
					policy: backend.policy
				},
				providerConfig: {}
			});
		}
	});

	return {
		generation,
		context,
		backend,
		counts: () => ({ opens, disposals, reads }),
		invalidate: () => {
			isLive = false;
		}
	};
}

it('initialises diagnostics without provisioning, then shares one lazy startup', async () => {
	const { generation, context, counts } = fixture();
	const status = await generation.status();

	expect(status.state).toBe('idle');

	const providersInfo = await generation.providers();

	expect(providersInfo.map((provider) => provider.id)).toStrictEqual([
		'fixture'
	]);
	expect(counts()).toStrictEqual({ opens: 0, disposals: 0, reads: 1 });

	const [first, second] = await Promise.all([
		generation.acquire(context),
		generation.acquire(context)
	]);

	expect({
		backendIds: [first.backendId, second.backendId],
		sameGeneration: first.generationId === second.generationId,
		...counts()
	}).toStrictEqual({
		backendIds: ['memory', 'memory'],
		sameGeneration: true,
		opens: 1,
		disposals: 0,
		reads: 1
	});
	expect(await generation.close()).toStrictEqual({
		confirmed: true,
		recoveries: [],
		failures: []
	});
	expect(await generation.close()).toStrictEqual({
		confirmed: true,
		recoveries: [],
		failures: []
	});
	expect(counts()).toStrictEqual({ opens: 1, disposals: 1, reads: 1 });
	await expect(first.files.readFile('file')).rejects.toMatchObject({
		name: 'SandboxSessionClosingError'
	});
});

it('keeps startup running when all current acquisition waiters cancel', async () => {
	const gate = Promise.withResolvers<SandboxBackend>();
	const started = Promise.withResolvers<SandboxOpenContext>();
	const { generation, context, backend, counts } = fixture((opening) => {
		started.resolve(opening);

		return gate.promise;
	});
	const caller = new AbortController();
	const pending = generation.acquire(context, { signal: caller.signal });
	const rejected = expect(pending).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		reason: 'caller',
		completion: 'not-started'
	});
	const opening = await started.promise;

	caller.abort();
	await rejected;
	expect(opening.signal.aborted).toBe(false);
	gate.resolve(backend);

	const sandbox = await generation.acquire(context);

	expect({ backendId: sandbox.backendId, ...counts() }).toStrictEqual({
		backendId: 'memory',
		opens: 1,
		disposals: 0,
		reads: 1
	});
	await generation.close();
});

it('uses independent waiter deadlines and preserves startup failure until close', async () => {
	vi.useFakeTimers();

	const gate = Promise.withResolvers<SandboxBackend>();
	const { generation, context, counts } = fixture(() => gate.promise);
	const short = generation.acquire(context, { timeoutMs: 10 });
	const long = generation.acquire(context, { timeoutMs: 100 });
	const rejectedShort = expect(short).rejects.toMatchObject({
		name: 'SandboxTimeoutError',
		completion: 'not-started'
	});
	const rejectedLong = expect(long).rejects.toMatchObject({
		name: 'SandboxStartupError'
	});

	await vi.advanceTimersByTimeAsync(10);
	await rejectedShort;
	gate.reject(new Error('provider failed'));
	await rejectedLong;
	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'SandboxStartupError'
	});
	expect(counts()).toStrictEqual({ opens: 1, disposals: 0, reads: 1 });
	await generation.close();
	expect(vi.getTimerCount()).toBe(0);
});

it('sets the close barrier before awaiting opening and never publishes a late backend', async () => {
	const gate = Promise.withResolvers<SandboxBackend>();
	const started = Promise.withResolvers<SandboxOpenContext>();
	const { generation, context, backend, counts } = fixture((opening) => {
		started.resolve(opening);

		return gate.promise;
	});
	const acquiring = generation.acquire(context);
	const rejected = expect(acquiring).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		reason: 'shutdown'
	});
	const opening = await started.promise;
	const closing = generation.close();

	expect(opening.signal.aborted).toBe(true);
	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'SandboxSessionClosingError'
	});
	gate.resolve(backend);
	await rejected;
	expect(await closing).toStrictEqual({
		confirmed: true,
		recoveries: [],
		failures: []
	});
	expect(counts()).toStrictEqual({ opens: 1, disposals: 1, reads: 1 });
});

it('checks the live Pi context on every cached facade operation', async () => {
	const { generation, context, invalidate } = fixture();
	const sandbox = await generation.acquire(context);

	invalidate();
	await expect(
		sandbox.exec({ kind: 'argv', executable: 'program', args: [] })
	).rejects.toMatchObject({ name: 'StaleSandboxHandleError' });
	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'StaleSandboxHandleError'
	});
	await generation.close();
});

it('checks requirements independently after sharing startup', async () => {
	const { generation, context, counts } = fixture();

	await expect(
		generation.acquire(context, { capabilities: ['search.grep'] })
	).rejects.toMatchObject({ name: 'UnsupportedSandboxCapabilityError' });

	const sandbox = await generation.acquire(context);

	expect(sandbox.backendId).toBe('memory');
	expect(counts()).toStrictEqual({ opens: 1, disposals: 0, reads: 1 });
	await generation.close();
});

it('bounds unresponsive opening, reports recovery, and disposes a later allocation once', async () => {
	vi.useFakeTimers();

	const gate = Promise.withResolvers<SandboxBackend>();
	const started = Promise.withResolvers<SandboxOpenContext>();
	const { generation, context, backend, counts } = fixture((opening) => {
		opening.reportRecovery({
			kind: 'allocation',
			id: 'pending',
			lease: 'lease',
			instructions: 'Recover allocations with lease.'
		});
		started.resolve(opening);

		return gate.promise;
	});
	const acquiring = generation.acquire(context);
	const rejected = expect(acquiring).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		reason: 'shutdown'
	});

	await started.promise;

	const closing = generation.close();

	await vi.advanceTimersByTimeAsync(5000);
	await rejected;

	const report = await closing;

	expect({
		confirmed: report.confirmed,
		recoveries: report.recoveries,
		failures: report.failures.map((error) => error.name)
	}).toStrictEqual({
		confirmed: false,
		recoveries: [
			{
				kind: 'allocation',
				id: 'pending',
				lease: 'lease',
				instructions: 'Recover allocations with lease.'
			}
		],
		failures: ['UnconfirmedSandboxTerminationError']
	});
	gate.resolve(backend);
	await vi.advanceTimersByTimeAsync(0);
	expect(counts()).toStrictEqual({ opens: 1, disposals: 1, reads: 1 });
	expect(await generation.close()).toBe(report);
	expect(vi.getTimerCount()).toBe(0);
});

it('bounds disposal and preserves recovery when cleanup is unconfirmed', async () => {
	vi.useFakeTimers();

	const { generation, context, backend } = fixture();

	backend.dispose = () => Promise.withResolvers<never>().promise;
	await generation.acquire(context);

	const closing = generation.close();

	await vi.advanceTimersByTimeAsync(10_000);

	const report = await closing;

	expect({
		confirmed: report.confirmed,
		failures: report.failures.map((error) => error.name)
	}).toStrictEqual({ confirmed: false, failures: ['SandboxCleanupError'] });
	expect(vi.getTimerCount()).toBe(0);
});

it('freezes provider services before asynchronous configuration completes', async () => {
	const backend = new MemoryBackend();
	const configGate = Promise.withResolvers<SandboxConfig>();
	const configured = Promise.withResolvers<string>();
	const providers: ProviderServiceV1[] = [
		{
			id: 'fixture',
			label: 'Fixture',
			capabilities: backend.capabilities,
			policies: {
				workspaceAccess: ['read-write'],
				filesystemScope: ['provider-default'],
				networkAccess: ['provider-default']
			},
			configure: () => ({ open: () => Promise.resolve(backend) })
		}
	];
	const context: SandboxContext = {
		cwd: '/host/workspace',

		sessionManager: SessionManager.inMemory('/host/workspace')
	};
	const generation = new SandboxGeneration(context, {
		providers: () => providers,
		readConfig: () => {
			configured.resolve('configured');

			return configGate.promise;
		}
	});
	const acquisition = generation.acquire(context);

	await configured.promise;
	providers.length = 0;
	configGate.resolve({
		selection: {
			providerId: 'fixture',
			source: 'personal',
			policy: backend.policy
		},
		providerConfig: {}
	});

	const sandbox = await acquisition;

	expect(sandbox.providerId).toBe('fixture');

	const providersInfo = await generation.providers();

	expect(providersInfo.map((provider) => provider.id)).toStrictEqual([
		'fixture'
	]);
	await generation.close();
});

it('closes before configuration completes without starting a provider afterwards', async () => {
	vi.useFakeTimers();

	const backend = new MemoryBackend();
	const gate = Promise.withResolvers<SandboxConfig>();
	const configured = Promise.withResolvers<string>();
	let opens = 0;
	const provider: ProviderServiceV1 = {
		id: 'fixture',
		label: 'Fixture',
		capabilities: backend.capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		configure: () => ({
			open: () => {
				opens++;

				return Promise.resolve(backend);
			}
		})
	};
	const context: SandboxContext = {
		cwd: '/host/workspace',

		sessionManager: SessionManager.inMemory('/host/workspace')
	};
	const generation = new SandboxGeneration(context, {
		providers: () => [provider],
		readConfig: () => {
			configured.resolve('configured');

			return gate.promise;
		}
	});
	const acquisition = generation.acquire(context);
	const rejected = expect(acquisition).rejects.toMatchObject({
		name: 'SandboxCancelledError'
	});

	await configured.promise;

	const closing = generation.close();

	await vi.advanceTimersByTimeAsync(0);

	let isClosed = false;

	async function recordClose() {
		const report = await closing;

		isClosed = report.confirmed;
	}

	const recorded = recordClose();

	await vi.advanceTimersByTimeAsync(0);
	expect(isClosed).toBe(true);
	gate.resolve({
		selection: {
			providerId: 'fixture',
			source: 'personal',
			policy: backend.policy
		},
		providerConfig: {}
	});
	await recorded;
	await rejected;
	await vi.advanceTimersByTimeAsync(0);
	expect({ opens, timers: vi.getTimerCount() }).toStrictEqual({
		opens: 0,
		timers: 0
	});
});

it('disposes an invalid opened backend once and keeps the startup failure', async () => {
	const backend = new MemoryBackend();
	let disposals = 0;
	const invalid = {
		...snapshotBackend(backend),
		workspace: { ...backend.workspace, root: 'relative' },
		dispose: () => {
			disposals++;

			return Promise.resolve();
		}
	};
	const { generation, context, counts } = fixture(() =>
		Promise.resolve(invalid)
	);

	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError'
	});
	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError'
	});
	expect(await generation.close()).toStrictEqual({
		confirmed: true,
		recoveries: [],
		failures: []
	});
	expect({ disposals, opens: counts().opens }).toStrictEqual({
		disposals: 1,
		opens: 1
	});
});

it.each(['relative', '/remote/project'])(
	'retains valid recovery metadata from a rejected backend at %s',
	async (root) => {
		const backend = new MemoryBackend();
		const recovery = {
			kind: 'allocation',
			id: 'known-allocation',
			lease: 'lease',
			instructions: 'Recover the allocation with lease.'
		} as const;
		const invalid = {
			...snapshotBackend(backend),
			workspace: { ...backend.workspace, root },
			recovery,
			dispose: () => Promise.reject(new Error('cleanup failed'))
		};
		const { generation, context } = fixture(() => Promise.resolve(invalid));

		await expect(generation.acquire(context)).rejects.toMatchObject({
			name: 'InvalidSandboxDeclarationError'
		});

		const report = await generation.close();

		expect({
			confirmed: report.confirmed,
			recoveries: report.recoveries,
			failures: report.failures.map((error) => error.name)
		}).toStrictEqual({
			confirmed: false,
			recoveries: [recovery],
			failures: ['SandboxCleanupError']
		});
	}
);

it.each(['/remote', '/remote/project/nested'])(
	'keeps target paths unchanged when the host workspace overlaps: %s',
	async (hostWorkspace) => {
		const { generation, context, backend } = fixture(undefined, hostWorkspace);

		backend.seed('file', new Uint8Array([1, 2]));

		const sandbox = await generation.acquire(context);

		try {
			const bytes = await sandbox.files.readFile('/remote/project/file');

			expect({
				host: context.cwd,
				target: sandbox.workspace.root,
				bytes,
				calls: backend.calls
			}).toStrictEqual({
				host: hostWorkspace,
				target: '/remote/project',
				bytes: new Uint8Array([1, 2]),
				calls: [{ operation: 'readFile', path: '/remote/project/file' }]
			});
		} finally {
			await generation.close();
		}
	}
);

it('replaces the aggregate recovery descriptor when its lease description changes', async () => {
	const initial = {
		kind: 'allocation',
		id: 'pending',
		lease: 'provisioning',
		instructions: 'Find pending resources.'
	} as const;
	const latest = {
		...initial,
		id: 'allocated',
		lease: 'manual cleanup',
		instructions: 'Remove allocated resources.'
	};
	const { generation, context } = fixture((opening) => {
		opening.reportRecovery(initial);
		opening.reportRecovery(latest);

		return Promise.reject(new Error('startup failed'));
	});

	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'SandboxStartupError',
		recovery: latest
	});

	const report = await generation.close();

	expect({
		confirmed: report.confirmed,
		recoveries: report.recoveries
	}).toStrictEqual({ confirmed: false, recoveries: [latest] });
});

it('rejects conflicting backend recovery metadata without losing either recovery procedure', async () => {
	const reported = {
		kind: 'allocation',
		id: 'first',
		lease: 'manual cleanup',
		instructions: 'Remove first.'
	} as const;
	const candidate = {
		...reported,
		id: 'second',
		instructions: 'Remove second.'
	};
	const { generation, context, backend } = fixture((opening) => {
		opening.reportRecovery(reported);

		return Promise.resolve({
			...snapshotBackend(backend),
			recovery: candidate,
			dispose: () => Promise.reject(new Error('cleanup failed'))
		});
	});

	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError',
		recovery: reported
	});

	const report = await generation.close();

	expect({
		confirmed: report.confirmed,
		recoveries: report.recoveries
	}).toStrictEqual({ confirmed: false, recoveries: [reported, candidate] });
});

it('rejects an attempt to erase outstanding recovery metadata', async () => {
	const recovery = {
		kind: 'allocation',
		id: 'allocation',
		lease: 'manual cleanup',
		instructions: 'Remove allocation.'
	} as const;
	const { generation, context } = fixture((opening) => {
		opening.reportRecovery(recovery);
		opening.reportRecovery({ kind: 'none' });

		return Promise.reject(new Error('unreachable'));
	});

	await expect(generation.acquire(context)).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError',
		recovery
	});

	const report = await generation.close();

	expect({
		confirmed: report.confirmed,
		recoveries: report.recoveries
	}).toStrictEqual({ confirmed: false, recoveries: [recovery] });
});

it.each(['workspaceAccess', 'filesystemScope', 'networkAccess'] as const)(
	'treats undefined %s requirements as omitted',
	async (field) => {
		const options = acquireOptions({ policy: { [field]: undefined } });

		expect(options).toStrictEqual({
			signal: undefined,
			timeoutMs: undefined,
			policy: {}
		});

		const { generation, context } = fixture();

		try {
			const sandbox = await generation.acquire(context, options);

			expect(sandbox.backendId).toBe('memory');
		} finally {
			await generation.close();
		}
	}
);

it('rejects unknown acquisition policy keys even when undefined', () => {
	expect(() => acquireOptions({ policy: { unrecognised: undefined } })).toThrow(
		expect.objectContaining({ name: 'InvalidSandboxRequestError' })
	);
});

it.each([true, false])(
	'retains backend recovery after an invalid return following cleanup acknowledgement, reported none: %s',
	async (reportsNone) => {
		const recovery = {
			kind: 'allocation',
			id: 'unexpected-backend',
			lease: 'manual cleanup',
			instructions: 'Remove unexpected-backend.'
		} as const;
		const { generation, context, backend } = fixture((opening) => {
			if (reportsNone) {
				opening.reportRecovery({ kind: 'none' });
			}

			opening.confirmCleanup();

			return Promise.resolve({
				...snapshotBackend(backend),
				recovery,
				dispose: () => Promise.reject(new Error('disposal failed'))
			});
		});

		await expect(generation.acquire(context)).rejects.toMatchObject({
			name: 'InvalidSandboxDeclarationError',
			recovery
		});

		const report = await generation.close();

		expect({
			confirmed: report.confirmed,
			recoveries: report.recoveries,
			failures: report.failures.map((error) => error.name)
		}).toStrictEqual({
			confirmed: false,
			recoveries: [recovery],
			failures: ['SandboxCleanupError']
		});
	}
);

it('omits recovery after a rejected backend confirms disposal', async () => {
	const recovery = {
		kind: 'allocation',
		id: 'released-backend',
		lease: 'manual cleanup',
		instructions: 'Remove released-backend.'
	} as const;
	const { generation, context, backend } = fixture((opening) => {
		opening.reportRecovery(recovery);

		return Promise.resolve({
			...snapshotBackend(backend),
			workspace: { ...backend.workspace, root: 'invalid' },
			recovery
		});
	});
	const result = await observe(generation.acquire(context));
	const status = await generation.status();

	expect({
		kind: result.kind,
		recovery: status.failure?.recovery,
		report: await generation.close()
	}).toStrictEqual({
		kind: 'rejected',
		recovery: undefined,
		report: { confirmed: true, failures: [], recoveries: [] }
	});
});

it('expires one acquisition waiter after synchronous configuration without cancelling shared startup', async () => {
	let now = 0;
	const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
	const { generation, context, counts } = fixture(
		undefined,
		'/host/workspace',
		() => {
			now = 100;
		}
	);

	try {
		const first = observe(generation.acquire(context, { timeoutMs: 5 }));
		const second = generation.acquire(context, { timeoutMs: 1000 });

		expect(await first).toMatchObject({
			kind: 'rejected',
			error: { name: 'SandboxTimeoutError', completion: 'not-started' }
		});

		const sandbox = await second;

		expect({
			backendId: sandbox.backendId,
			counts: counts()
		}).toStrictEqual({
			backendId: 'memory',
			counts: { reads: 1, opens: 1, disposals: 0 }
		});
	} finally {
		await generation.close();
		clock.mockRestore();
	}
});

it.each([
	{ source: 'deadline', failsCleanup: true },
	{ source: 'deadline', failsCleanup: false },
	{ source: 'shutdown', failsCleanup: true },
	{ source: 'shutdown', failsCleanup: false }
] as const)(
	'classifies late $source opening from disposal confirmation: failure $failsCleanup',
	async ({ source, failsCleanup }) => {
		vi.useFakeTimers();

		const gate = Promise.withResolvers<SandboxBackend>();
		const started = Promise.withResolvers<undefined>();
		const recovery = {
			kind: 'allocation',
			id: 'late-allocation',
			lease: 'manual cleanup',
			instructions: 'Remove late-allocation.'
		} as const;
		const { generation, context, backend } = fixture((opening) => {
			opening.reportRecovery(recovery);
			started.resolve(undefined);

			return gate.promise;
		});
		const acquiring = observe(
			generation.acquire(context, { timeoutMs: 120_000 })
		);

		await started.promise;

		const closing = source === 'shutdown' ? generation.close() : undefined;

		if (source === 'deadline') {
			await vi.advanceTimersByTimeAsync(60_000);
		}

		gate.resolve({
			...snapshotBackend(backend),
			recovery,
			dispose: () =>
				failsCleanup
					? Promise.reject(new Error('disposal failed'))
					: Promise.resolve()
		});

		const acquired = await acquiring;
		const report = await (closing ?? generation.close());
		const status = await generation.status();
		const failure = status.failure;

		expect({
			acquisition: acquired.kind === 'rejected' ? acquired.error : undefined,
			failure: {
				name: failure?.name,
				completion:
					failure !== undefined && 'completion' in failure
						? failure.completion
						: undefined
			},
			report: {
				confirmed: report.confirmed,
				recoveries: report.recoveries,
				failures: report.failures.map((error) => error.name)
			}
		}).toMatchObject({
			acquisition: {
				name:
					source === 'deadline'
						? 'SandboxTimeoutError'
						: 'SandboxCancelledError',
				completion:
					source === 'shutdown'
						? 'not-started'
						: failsCleanup
							? 'unknown'
							: 'confirmed'
			},
			failure: {
				name:
					source === 'deadline'
						? 'SandboxTimeoutError'
						: 'SandboxCancelledError',
				completion: failsCleanup ? 'unknown' : 'confirmed'
			},
			report: {
				confirmed: !failsCleanup,
				recoveries: failsCleanup ? [recovery] : [],
				failures: failsCleanup ? ['SandboxCleanupError'] : []
			}
		});
	}
);

it('returns the expired waiter deadline before a synchronous configuration rejection', async () => {
	let now = 0;
	const clock = vi.spyOn(performance, 'now').mockImplementation(() => now);
	const { generation, context, counts } = fixture(
		undefined,
		'/host/workspace',
		() => {
			now = 100;

			throw new Error('Configuration failed.');
		}
	);

	try {
		await expect(
			generation.acquire(context, { timeoutMs: 5 })
		).rejects.toMatchObject({
			name: 'SandboxTimeoutError',
			completion: 'not-started'
		});
		await expect(
			generation.acquire(context, { timeoutMs: 1000 })
		).rejects.toMatchObject({ name: 'SandboxInitialisationError' });
		expect(counts()).toStrictEqual({ reads: 1, opens: 0, disposals: 0 });
	} finally {
		await generation.close();
		clock.mockRestore();
	}
});
