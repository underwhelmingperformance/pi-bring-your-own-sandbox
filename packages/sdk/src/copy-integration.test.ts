import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { createSandboxClient } from './client.js';
import type {
	SandboxBackend,
	SandboxCopySource,
	SandboxHost,
	SandboxPolicy,
	SandboxWorkspace
} from './contracts.js';
import {
	isSandboxError,
	SandboxCleanupError,
	SandboxOperationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import {
	closeSandboxSession,
	fixtureOwner,
	fixtureTools,
	setFixtureSession
} from './fixtures/fixture-client.js';
import { getSandbox } from './fixtures/fixture-client.js';
import { copyHostWorkspace } from './fixtures/fixture-client.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import type { FixtureCapabilities } from './fixtures/profile-fixture.js';
import type { FixturePolicyChoices } from './fixtures/profile-fixture.js';
import { fixtureProfile, fixtureProfiles } from './fixtures/profile-fixture.js';
import type { FixtureProvider } from './fixtures/register-provider.js';
import { registerFixtureProvider } from './fixtures/register-provider.js';
import { registerSandboxProvider } from './provider-registration.js';
import { checkedCopy } from './sandbox-copy.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

const ALL_POLICIES: FixturePolicyChoices = {
	hostWorkspaceWrites: [true, false],
	hostUserData: ['denied'],
	hostSystemFiles: ['read-only', 'denied'],
	network: [false]
};

const capabilities: FixtureCapabilities = {
	processKinds: ['argv', 'shell'],
	terminationScope: 'workload',
	exitStatus: 'guaranteed',
	operations: ['files.read', 'files.write', 'files.list'],
	shells: ['sh']
};

async function fixture(
	run: (
		pi: SandboxHost,
		context: { cwd: string; sessionManager: SessionManager }
	) => Promise<void>
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-copy-'));

	vi.stubEnv('PI_CODING_AGENT_DIR', directory);

	const pi: SandboxHost = {
		events: createEventBus(),
		on: vi.fn(() => vi.fn()),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => fixtureTools(pi)
	};

	createSandboxClient(pi, import.meta.filename);

	const context = {
		cwd: directory,
		sessionManager: SessionManager.inMemory(directory)
	};

	setFixtureSession(pi, context);

	try {
		await run(pi, context);
	} finally {
		await closeSandboxSession(pi);
		await rm(directory, { recursive: true, force: true });
	}
}

function backendFor(
	template: MemoryBackend,
	id: string,
	policy: SandboxPolicy,
	relationship: SandboxWorkspace['relationship'],
	onDispose?: () => void
): SandboxBackend {
	return {
		id,
		workspace: { ...template.workspace, relationship },

		profile: fixtureProfile(policy, capabilities),
		policyDescription: 'Copy fixture',
		recovery: template.recovery,
		...(template.files && { files: template.files }),
		exec: template.exec.bind(template),
		dispose: () => {
			onDispose?.();

			return Promise.resolve();
		}
	};
}

interface CopyProviderOptions {
	readonly policies?: FixturePolicyChoices;
	readonly relationship?: SandboxWorkspace['relationship'];
}

function registerCopyProvider(pi: SandboxHost, options?: CopyProviderOptions) {
	const template = new MemoryBackend();
	const copies: { source: SandboxCopySource; policy: SandboxPolicy }[] = [];
	const released: string[] = [];
	const opened: SandboxBackend[] = [];
	const provider: FixtureProvider<object> = {
		id: 'active',
		label: 'active',

		profiles: fixtureProfiles(
			capabilities,
			options?.policies ?? ALL_POLICIES,
			true
		),

		validateConfig: () => ({}),
		open: (request) => {
			const backend = backendFor(
				template,
				'ordinary',
				request.profile.policy,
				'shared'
			);

			opened.push(backend);

			return Promise.resolve(backend);
		},
		copy: (request) => {
			copies.push({ source: request.source, policy: request.profile.policy });

			const id = 'copy-' + String(copies.length);

			return Promise.resolve(
				backendFor(
					template,
					id,
					request.profile.policy,
					options?.relationship ?? 'copied',
					() => {
						released.push(id);
					}
				)
			);
		}
	};

	registerFixtureProvider(pi, import.meta.filename, provider);

	return { copies, released, opened };
}

it('copies a sandbox into private allocations with the highest-ranked supported policy', async () => {
	await fixture(async (pi, context) => {
		const { copies, released, opened } = registerCopyProvider(pi);
		const target = await getSandbox(pi, context);
		const first = await target.copy();
		const second = await target.copy();
		const selected = {
			hostWorkspaceWrites: false,
			hostUserData: 'denied',
			hostSystemFiles: 'read-only',
			network: false
		};

		expect({
			copies,
			sandboxes: [first.sandbox, second.sandbox].map((sandbox) => ({
				backendId: sandbox.backendId,
				relationship: sandbox.workspace.relationship,
				policy: sandbox.profile.policy
			}))
		}).toStrictEqual({
			copies: [0, 1].map(() => ({
				source: { kind: 'backend', backend: opened[0] },
				policy: selected
			})),
			sandboxes: ['copy-1', 'copy-2'].map((backendId) => ({
				backendId,
				relationship: 'copied',
				policy: selected
			}))
		});

		await first.close();
		await expect(first.sandbox.files.readFile('file')).rejects.toMatchObject({
			name: 'SandboxSessionClosingError'
		});
		expect(released).toStrictEqual(['copy-1']);
		await closeSandboxSession(pi);
		await expect(second.close()).resolves.toMatchObject({ confirmed: true });
		expect(released).toStrictEqual(['copy-1', 'copy-2']);
	});
});

it('satisfies a copy need for readable host system files within the configured policy', async () => {
	await fixture(async (pi, context) => {
		const { copies } = registerCopyProvider(pi);
		const target = await getSandbox(pi, context);
		const copy = await target.copy({ access: { hostSystemFiles: 'needed' } });
		const expected = {
			hostWorkspaceWrites: false,
			hostUserData: 'denied',
			hostSystemFiles: 'read-only',
			network: false
		};

		expect({
			requested: copies.map(({ policy }) => policy),
			effective: copy.sandbox.profile.policy
		}).toStrictEqual({ requested: [expected], effective: expected });
	});
});

it('limits needs in a copy of a copy by the configured policy', async () => {
	await fixture(async (pi, context) => {
		const { copies } = registerCopyProvider(pi);
		const target = await getSandbox(pi, context);
		const first = await target.copy();
		const nested = await first.sandbox.copy({
			access: { hostSystemFiles: 'needed' }
		});
		const policy = {
			hostWorkspaceWrites: false,
			hostUserData: 'denied',
			hostSystemFiles: 'read-only',
			network: false
		};

		const source = copies[1]?.source;

		expect({
			source: source?.kind === 'backend' ? source.backend.id : source,
			requested: copies[1]?.policy,
			effective: nested.sandbox.profile.policy
		}).toStrictEqual({
			source: 'copy-1',
			requested: policy,
			effective: policy
		});
	});
});

it('rejects a copy of a closed sandbox through the returned promise', async () => {
	await fixture(async (pi, context) => {
		registerCopyProvider(pi);

		const target = await getSandbox(pi, context);
		let copying: Promise<unknown> | undefined;

		await closeSandboxSession(pi);
		expect(() => {
			copying = target.copy();
		}).not.toThrow();
		await expect(copying).rejects.toMatchObject({
			name: 'SandboxSessionClosingError'
		});
	});
});

it('uses the strictest scope that a provider offers when it lacks the strongest', async () => {
	await fixture(async (pi, context) => {
		registerCopyProvider(pi, {
			policies: {
				...ALL_POLICIES,
				hostUserData: ['denied'],
				hostSystemFiles: ['read-only']
			}
		});

		const target = await getSandbox(pi, context);
		const copy = await target.copy({ access: { hostUserData: 'prevented' } });

		expect(copy.sandbox.profile.policy.hostSystemFiles).toBe('read-only');
	});
});

it.each([
	{
		name: 'a need for access beyond the configured policy',
		access: { network: 'needed' as const }
	},
	{
		name: 'a restriction that the provider cannot supply',
		access: { hostSystemFiles: 'prevented' as const }
	},
	{
		name: 'a need to write the live checkout',
		access: { hostWorkspaceWrites: 'needed' as const }
	}
])('rejects $name before copying', async ({ access }) => {
	await fixture(async (pi, context) => {
		const { copies } = registerCopyProvider(pi, {
			policies: { ...ALL_POLICIES, hostSystemFiles: ['read-only'] }
		});

		await expect(
			copyHostWorkspace(pi, context, { access })
		).rejects.toMatchObject({
			name: 'UnsupportedSandboxPolicyError',
			providerId: 'active'
		});
		expect(copies).toStrictEqual([]);
	});
});

it('copies the host workspace for a host source', async () => {
	await fixture(async (pi, context) => {
		const { copies, opened } = registerCopyProvider(pi);
		const copy = await copyHostWorkspace(pi, context);

		expect({
			sources: copies.map(({ source }) => source),
			opened,
			backendId: copy.sandbox.backendId
		}).toStrictEqual({
			sources: [{ kind: 'host' }],
			opened: [],
			backendId: 'copy-1'
		});
	});
});

it('rejects a copy of a stale sandbox identity', async () => {
	await fixture(async (pi, context) => {
		const { copies } = registerCopyProvider(pi);
		const target = await getSandbox(pi, context);

		await expect(
			fixtureOwner(pi).copy(context, {
				kind: 'sandbox',
				providerId: target.providerId,
				generationId: 'stale',
				backendId: target.backendId
			})
		).rejects.toMatchObject({ name: 'StaleSandboxHandleError' });
		expect(copies).toStrictEqual([]);
	});
});

it('rejects a copy whose backend does not report a copied workspace and disposes it', async () => {
	await fixture(async (pi, context) => {
		const { released } = registerCopyProvider(pi, { relationship: 'shared' });
		const target = await getSandbox(pi, context);

		await expect(target.copy()).rejects.toMatchObject({
			name: 'InvalidSandboxDeclarationError',
			operation: 'open',
			providerId: 'active'
		});
		expect(released).toStrictEqual(['copy-1']);
	});
});

it('rejects copies from a provider without copy profiles', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend();

		registerFixtureProvider(pi, import.meta.filename, {
			id: 'ordinary',
			label: 'ordinary',

			profiles: fixtureProfiles(backend.capabilities, {
				hostWorkspaceWrites: [true],
				hostUserData: ['denied'],
				hostSystemFiles: ['read-only'],
				network: [false]
			}),

			validateConfig: () => ({}),
			open: () => Promise.resolve(backend)
		});

		const target = await getSandbox(pi, context);

		await expect(target.copy()).rejects.toMatchObject({
			name: 'UnsupportedSandboxCapabilityError',
			operation: 'acquire',
			providerId: 'ordinary',
			detail: { kind: 'copy-unavailable' }
		});
		await expect(copyHostWorkspace(pi, context)).rejects.toMatchObject({
			name: 'UnsupportedSandboxCapabilityError',
			operation: 'acquire',
			providerId: 'ordinary',
			detail: { kind: 'copy-unavailable' }
		});
	});
});

it.each([
	['declares copy without implementing it', true, false],
	['implements copy without declaring it', false, true]
])(
	'rejects a provider that %s before configuration or allocation',
	async (_, declared, implemented) => {
		await fixture(async (pi, context) => {
			const backend = new MemoryBackend();
			const configure = vi.fn(() => ({ configuration: undefined }));
			const open = vi.fn(() => Promise.resolve(backend));
			const copy = vi.fn(() => Promise.resolve(backend));

			registerSandboxProvider(pi, import.meta.filename, {
				id: 'inconsistent',
				label: 'inconsistent',
				profiles: fixtureProfiles(
					backend.capabilities,
					{
						hostWorkspaceWrites: [true],
						hostUserData: ['denied'],
						hostSystemFiles: ['read-only'],
						network: [false]
					},
					declared
				),
				create: () => ({ configure, open, ...(implemented && { copy }) })
			});

			await expect(getSandbox(pi, context)).rejects.toMatchObject({
				name: 'InvalidSandboxConfigError',
				providerId: 'inconsistent',
				detail: { kind: 'config', field: 'provider.create' }
			});
			expect({
				configure: configure.mock.calls,
				open: open.mock.calls,
				copy: copy.mock.calls
			}).toStrictEqual({ configure: [], open: [], copy: [] });
		});
	}
);

it('retains the entire close report when a copy fails validation', async () => {
	const recoveries = ['first', 'second'].map((id) => ({
		kind: 'allocation' as const,
		id,
		lease: 'manual',
		instructions: `Remove ${id}.`
	}));
	const failures = [
		new SandboxOperationError({ operation: 'dispose', backendId: 'first' }),
		new SandboxCleanupError({ operation: 'dispose', backendId: 'second' })
	];
	const report = { confirmed: false, failures, recoveries };

	const target = createSandbox(new TestBackendOwner(new MemoryBackend()));
	const copy = {
		sandbox: {
			...target,
			providerId: 'independent',
			backendId: 'remaining',
			profile: { ...target.profile, capabilities: [] }
		},
		close: () => Promise.resolve(report)
	};

	const [outcome] = await Promise.allSettled([
		checkedCopy(copy, { capabilities: ['files.read'] }, import.meta.filename)
	]);
	const rejected: unknown =
		outcome.status === 'rejected' ? outcome.reason : undefined;

	if (!isSandboxError(rejected, SandboxCleanupError)) {
		throw new Error('Expected copy cleanup to fail.', { cause: rejected });
	}

	expect({
		operation: rejected.operation,
		providerId: rejected.providerId,
		backendId: rejected.backendId,
		closeReport: rejected.closeReport,
		hasOriginalCause: isSandboxError(
			rejected.cause,
			UnsupportedSandboxCapabilityError
		)
	}).toStrictEqual({
		operation: 'dispose',
		providerId: 'independent',
		backendId: 'remaining',
		closeReport: report,
		hasOriginalCause: true
	});
});
