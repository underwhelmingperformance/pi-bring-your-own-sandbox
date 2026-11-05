import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { snapshotBackend } from './backend-snapshot.js';
import type {
	SandboxBackend,
	SandboxContext,
	SandboxOpenContext,
	SandboxPolicy,
	SupportedSandboxPolicies
} from './contracts.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { SandboxGeneration } from './generation.js';
import type { ProviderServiceV1 } from './protocol.js';

const PERSONAL: SandboxPolicy = {
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
};

const RESTRICTED: SandboxPolicy = {
	workspaceAccess: 'read-only',
	filesystemScope: 'workspace-only',
	networkAccess: 'denied'
};

const ALL_POLICIES: SupportedSandboxPolicies = {
	workspaceAccess: ['read-only', 'read-write'],
	filesystemScope: ['workspace-only', 'system-read-only', 'provider-default'],
	networkAccess: ['denied', 'provider-default']
};

class PolicyBackend extends MemoryBackend {
	override readonly id: string;
	override readonly policy: SandboxPolicy;

	constructor(policy: SandboxPolicy) {
		super();
		this.policy = policy;
		this.id = `memory:${policy.workspaceAccess}:${policy.networkAccess}`;
	}
}

interface FixtureOptions {
	readonly protection?: boolean;
	readonly personal?: SandboxPolicy;
	readonly policies?: SupportedSandboxPolicies;
	readonly open?: (
		policy: SandboxPolicy,
		opening: SandboxOpenContext
	) => Promise<SandboxBackend>;
}

function fixture(options: FixtureOptions = {}) {
	const opened: SandboxPolicy[] = [];
	const disposed: string[] = [];
	const context: SandboxContext = {
		cwd: '/host/workspace',
		sessionManager: SessionManager.inMemory('/host/workspace')
	};
	const template = new MemoryBackend().capabilities;
	const capabilities = options.protection
		? {
				...template,
				operations: [...template.operations, 'workspace.protection' as const]
			}
		: template;
	const provider: ProviderServiceV1 = {
		id: 'fixture',
		label: 'Fixture',
		capabilities,
		policies: options.policies ?? ALL_POLICIES,
		configure: () => ({
			open: (request, opening) => {
				opened.push(request.policy);

				if (options.open !== undefined) {
					return options.open(request.policy, opening);
				}

				const memory = new PolicyBackend(request.policy);
				const backend: SandboxBackend = {
					...snapshotBackend(memory),
					capabilities,
					dispose: () => {
						disposed.push(memory.id);

						return Promise.resolve();
					}
				};

				return Promise.resolve(backend);
			}
		})
	};
	const generation = new SandboxGeneration(context, {
		providers: () => [provider],
		readConfig: () =>
			Promise.resolve({
				selection: {
					providerId: 'fixture',
					source: 'extension',
					policy: options.personal ?? PERSONAL
				},
				providerConfig: {}
			})
	});

	return { generation, context, opened, disposed };
}

it('opens a backend for each distinct configuration and reuses it', async () => {
	const { generation, context, opened } = fixture();
	const unrestricted = await generation.acquire(context);
	const restricted = await generation.acquire(context, {
		policy: RESTRICTED
	});
	const again = await generation.acquire(context, { policy: RESTRICTED });

	expect({
		backends: [unrestricted.backendId, restricted.backendId, again.backendId],
		policies: [unrestricted.policy, restricted.policy],
		opened
	}).toStrictEqual({
		backends: [
			'memory:read-write:provider-default',
			'memory:read-only:denied',
			'memory:read-only:denied'
		],
		policies: [PERSONAL, RESTRICTED],
		opened: [PERSONAL, RESTRICTED]
	});
	await generation.close();
});

it('keeps a personal restriction when a request delegates that field', async () => {
	const personal: SandboxPolicy = { ...PERSONAL, networkAccess: 'denied' };
	const { generation, context, opened } = fixture({ personal });
	const sandbox = await generation.acquire(context, {
		policy: { networkAccess: 'provider-default' }
	});

	expect({ policy: sandbox.policy, opened }).toStrictEqual({
		policy: personal,
		opened: [personal]
	});
	await generation.close();
});

it.each([
	{
		name: 'a value that the provider does not declare',
		personal: PERSONAL,
		policies: { ...ALL_POLICIES, workspaceAccess: ['read-write'] },
		requested: { workspaceAccess: 'read-only' }
	},
	{
		name: 'a request that loosens the personal policy',
		personal: { ...PERSONAL, workspaceAccess: 'read-only' },
		policies: ALL_POLICIES,
		requested: { workspaceAccess: 'read-write' }
	}
] as const)(
	'rejects $name without opening a backend',
	async ({ personal, policies, requested }) => {
		const { generation, context, opened } = fixture({ personal, policies });

		await expect(
			generation.acquire(context, { policy: requested })
		).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
		expect(opened).toStrictEqual([]);
		await generation.close();
	}
);

it('rejects operations that the declaration lacks without opening a backend', async () => {
	const { generation, context, opened } = fixture();

	await expect(
		generation.acquire(context, { capabilities: ['search.grep'] })
	).rejects.toMatchObject({ name: 'UnsupportedSandboxCapabilityError' });
	expect(opened).toStrictEqual([]);
	await generation.close();
});

it('shares one startup between concurrent requests for a configuration', async () => {
	const gate = Promise.withResolvers<SandboxBackend>();
	const { generation, context, opened } = fixture({
		open: () => gate.promise
	});
	const caller = new AbortController();
	const cancelled = generation.acquire(context, {
		policy: RESTRICTED,
		signal: caller.signal
	});
	const waiting = generation.acquire(context, { policy: RESTRICTED });
	const rejected = expect(cancelled).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'not-started'
	});

	caller.abort();
	await rejected;
	gate.resolve(new PolicyBackend(RESTRICTED));

	const sandbox = await waiting;

	expect({ backendId: sandbox.backendId, opened }).toStrictEqual({
		backendId: 'memory:read-only:denied',
		opened: [RESTRICTED]
	});
	await generation.close();
});

it('disposes every backend when the generation closes', async () => {
	const { generation, context, disposed } = fixture();

	await generation.acquire(context);
	await generation.acquire(context, { policy: RESTRICTED });

	expect({
		report: await generation.close(),
		disposed: disposed.toSorted((left, right) => left.localeCompare(right))
	}).toStrictEqual({
		report: { confirmed: true, recoveries: [], failures: [] },
		disposed: ['memory:read-only:denied', 'memory:read-write:provider-default']
	});
});

it('keeps other backends usable after one fails to open', async () => {
	const { generation, context, opened } = fixture({
		open: (policy) =>
			policy.networkAccess === 'denied'
				? Promise.reject(new Error('provider failed'))
				: Promise.resolve(new PolicyBackend(policy))
	});

	await expect(
		generation.acquire(context, { policy: RESTRICTED })
	).rejects.toMatchObject({ name: 'SandboxStartupError' });

	const sandbox = await generation.acquire(context);

	await expect(
		generation.acquire(context, { policy: RESTRICTED })
	).rejects.toMatchObject({ name: 'SandboxStartupError' });
	expect({ backendId: sandbox.backendId, opened }).toStrictEqual({
		backendId: 'memory:read-write:provider-default',
		opened: [RESTRICTED, PERSONAL]
	});
	await generation.close();
});

it('lists every open backend in status', async () => {
	const { generation, context } = fixture();

	await generation.acquire(context);
	await generation.acquire(context, { policy: RESTRICTED });

	const status = await generation.status();

	expect(status.backends).toStrictEqual([
		{
			policy: PERSONAL,
			state: 'ready',
			backendId: 'memory:read-write:provider-default'
		},
		{
			policy: RESTRICTED,
			state: 'ready',
			backendId: 'memory:read-only:denied'
		}
	]);
	await generation.close();
});

it('negotiates a configuration without opening a backend', async () => {
	const { generation, context, opened } = fixture({
		policies: { ...ALL_POLICIES, networkAccess: ['provider-default'] }
	});
	const satisfiable = await generation.negotiate(context, {
		policy: { workspaceAccess: 'read-only' }
	});
	const unsatisfiable = await generation.negotiate(context, {
		policy: RESTRICTED
	});

	expect({
		satisfiable,
		unsatisfiable: {
			ok: unsatisfiable.ok,
			error: unsatisfiable.ok ? undefined : unsatisfiable.error.name
		},
		opened
	}).toStrictEqual({
		satisfiable: {
			ok: true,
			policy: { ...PERSONAL, workspaceAccess: 'read-only' }
		},
		unsatisfiable: { ok: false, error: 'UnsupportedSandboxPolicyError' },
		opened: []
	});

	const sandbox = await generation.acquire(context, {
		policy: { workspaceAccess: 'read-only' }
	});

	expect(sandbox.policy).toStrictEqual(
		satisfiable.ok ? satisfiable.policy : undefined
	);
	await generation.close();
});

it.each([
	['provider-default', 'provider-default', 'provider-default'],
	['provider-default', 'system-read-only', 'system-read-only'],
	['provider-default', 'workspace-only', 'workspace-only'],
	['system-read-only', 'provider-default', 'system-read-only'],
	['system-read-only', 'system-read-only', 'system-read-only'],
	['system-read-only', 'workspace-only', 'workspace-only'],
	['workspace-only', 'provider-default', 'workspace-only'],
	['workspace-only', 'system-read-only', 'workspace-only'],
	['workspace-only', 'workspace-only', 'workspace-only']
] as const)(
	'negotiates personal scope %s with consumer scope %s',
	async (personal, requested, expected) => {
		const { generation, context, opened } = fixture({
			personal: { ...PERSONAL, filesystemScope: personal }
		});

		try {
			const sandbox = await generation.acquire(context, {
				policy: { filesystemScope: requested }
			});
			const expectedPolicy = { ...PERSONAL, filesystemScope: expected };

			expect({ policy: sandbox.policy, opened }).toStrictEqual({
				policy: expectedPolicy,
				opened: [expectedPolicy]
			});
		} finally {
			await generation.close();
		}
	}
);

it('rejects a system-read-only request before opening an unsupported provider', async () => {
	const { generation, context, opened } = fixture({
		policies: { ...ALL_POLICIES, filesystemScope: ['provider-default'] }
	});

	try {
		await expect(
			generation.acquire(context, {
				policy: { filesystemScope: 'system-read-only' }
			})
		).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
		expect(opened).toStrictEqual([]);
	} finally {
		await generation.close();
	}
});

it('uses a stronger supported scope when the provider has no intermediate mode', async () => {
	const { generation, context, opened } = fixture({
		policies: { ...ALL_POLICIES, filesystemScope: ['workspace-only'] }
	});

	try {
		const sandbox = await generation.acquire(context, {
			policy: { filesystemScope: 'system-read-only' }
		});
		const expected = { ...PERSONAL, filesystemScope: 'workspace-only' };

		expect({ policy: sandbox.policy, opened }).toStrictEqual({
			policy: expected,
			opened: [expected]
		});
	} finally {
		await generation.close();
	}
});

it('rejects unsupported workspace protection before opening a writable backend', async () => {
	const { generation, context, opened } = fixture();

	try {
		await expect(
			generation.acquire(context, {
				policy: { workspaceProtection: [{ kind: 'git-metadata' }] }
			})
		).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
		expect(opened).toStrictEqual([]);
	} finally {
		await generation.close();
	}
});

it('combines personal and consumer workspace protections without sharing their arrays', async () => {
	const personal: SandboxPolicy = {
		...PERSONAL,
		workspaceProtection: [{ kind: 'git-metadata' }]
	};
	const { generation, context, opened } = fixture({
		personal,
		protection: true
	});
	const requested: NonNullable<SandboxPolicy['workspaceProtection']>[number][] =
		[{ kind: 'path', path: '.pi' }];

	try {
		const sandbox = await generation.acquire(context, {
			policy: { workspaceProtection: requested }
		});

		requested.push({ kind: 'path', path: '.extra' });

		const expected = {
			...PERSONAL,
			workspaceProtection: [
				{ kind: 'git-metadata' },
				{ kind: 'path', path: '.pi' }
			]
		};

		expect({
			policy: sandbox.policy,
			opened,
			frozen: Object.isFrozen(sandbox.policy.workspaceProtection)
		}).toStrictEqual({ policy: expected, opened: [expected], frozen: true });
	} finally {
		await generation.close();
	}
});

it.each(['/absolute', '../parent', 'a/../b', 'a//b', 'a\\b', 'C:drive', '.'])(
	'rejects non-portable protected path %s',
	async (path) => {
		const { generation, context, opened } = fixture();

		try {
			await expect(
				generation.acquire(context, {
					policy: { workspaceProtection: [{ kind: 'path', path }] }
				})
			).rejects.toMatchObject({ name: 'InvalidSandboxRequestError' });
			expect(opened).toStrictEqual([]);
		} finally {
			await generation.close();
		}
	}
);

it.each([{ kind: 'path', path: '.pi' }, { kind: 'git-metadata' }] as const)(
	'rejects %j without a protection capability even under read-only access',
	async (resource) => {
		const { generation, context, opened } = fixture({
			personal: { ...PERSONAL, workspaceAccess: 'read-only' }
		});

		try {
			await expect(
				generation.acquire(context, {
					policy: { workspaceProtection: [resource] }
				})
			).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
			expect(opened).toStrictEqual([]);
		} finally {
			await generation.close();
		}
	}
);

it.each([{ kind: 'path', path: '.pi' }, { kind: 'git-metadata' }] as const)(
	'preserves explicit %j protection when opening a read-only backend',
	async (resource) => {
		const { generation, context, opened } = fixture({
			protection: true,
			personal: { ...PERSONAL, workspaceAccess: 'read-only' }
		});

		try {
			const sandbox = await generation.acquire(context, {
				policy: { workspaceProtection: [resource] }
			});
			const expected = {
				...PERSONAL,
				workspaceAccess: 'read-only',
				workspaceProtection: [resource]
			};

			expect({ policy: sandbox.policy, opened }).toStrictEqual({
				policy: expected,
				opened: [expected]
			});
		} finally {
			await generation.close();
		}
	}
);

it('shares equivalent protection sets while separating different resources', async () => {
	const { generation, context, opened } = fixture({ protection: true });

	try {
		const first = await generation.acquire(context, {
			policy: {
				workspaceProtection: [
					{ kind: 'path', path: '.a' },
					{ kind: 'path', path: '.b' }
				]
			}
		});
		const repeated = await generation.acquire(context, {
			policy: {
				workspaceProtection: [
					{ kind: 'path', path: '.b' },
					{ kind: 'path', path: '.a' }
				]
			}
		});
		const other = await generation.acquire(context, {
			policy: { workspaceProtection: [{ kind: 'path', path: '.c' }] }
		});

		expect({
			shared: first.backendId === repeated.backendId,
			policies: opened,
			other: other.policy
		}).toStrictEqual({
			shared: true,
			policies: [
				{
					...PERSONAL,
					workspaceProtection: [
						{ kind: 'path', path: '.a' },
						{ kind: 'path', path: '.b' }
					]
				},
				{ ...PERSONAL, workspaceProtection: [{ kind: 'path', path: '.c' }] }
			],
			other: {
				...PERSONAL,
				workspaceProtection: [{ kind: 'path', path: '.c' }]
			}
		});
	} finally {
		await generation.close();
	}
});

it('rejects an opened backend that omits a promised protected resource and disposes it', async () => {
	let disposals = 0;
	const { generation, context } = fixture({
		protection: true,
		open: (policy) => {
			const backend = new PolicyBackend({ ...policy, workspaceProtection: [] });

			return Promise.resolve({
				...snapshotBackend(backend),
				capabilities: {
					...backend.capabilities,
					operations: [
						...backend.capabilities.operations,
						'workspace.protection'
					]
				},
				dispose: () => {
					disposals++;

					return Promise.resolve();
				}
			});
		}
	});

	try {
		await expect(
			generation.acquire(context, {
				policy: { workspaceProtection: [{ kind: 'git-metadata' }] }
			})
		).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
		expect(disposals).toBe(1);
	} finally {
		await generation.close();
	}
});

function protectionResources(prefix: string) {
	return Array.from({ length: 100 }, (_, index) => ({
		kind: 'path' as const,
		path: `${prefix}/${String(index)}`
	}));
}

it('rejects an oversized combined resource set before opening a backend', async () => {
	const { generation, context, opened } = fixture({
		protection: true,
		personal: {
			...PERSONAL,
			workspaceProtection: protectionResources('personal')
		}
	});

	try {
		await expect(
			generation.acquire(context, {
				policy: { workspaceProtection: protectionResources('consumer') }
			})
		).rejects.toMatchObject({ name: 'UnsupportedSandboxPolicyError' });
		expect(opened).toStrictEqual([]);
	} finally {
		await generation.close();
	}
});
