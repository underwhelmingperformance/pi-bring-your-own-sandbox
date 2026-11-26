import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';
import { afterEach, expect, it, vi } from 'vitest';

import { registerSandboxProvider, registerSandboxRequirement } from './api.js';
import { createSandboxClient } from './client.js';
import type {
	SandboxBackend,
	SandboxCapabilities,
	SandboxCopySource,
	SandboxHost,
	SandboxPolicy,
	SandboxProvider,
	SandboxRequirements,
	SandboxWorkspace,
	SupportedSandboxPolicies
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import {
	isSandboxError,
	SandboxCleanupError,
	SandboxOperationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import {
	closeSandboxSession,
	fixtureTools
} from './fixtures/fixture-client.js';
import { getSandbox } from './fixtures/fixture-client.js';
import { copyHostWorkspace } from './fixtures/fixture-client.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { brokerReply, respond } from './fixtures/protocol-peer.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

const ALL_POLICIES: SupportedSandboxPolicies = {
	workspaceAccess: ['read-write', 'read-only'],
	filesystemScope: ['provider-default', 'system-read-only', 'workspace-only'],
	networkAccess: ['provider-default', 'denied'],
	workspaceRelationship: ['remote']
};

const capabilities: SandboxCapabilities = {
	processKinds: ['argv', 'shell'],
	terminationScope: 'workload',
	exitStatus: 'guaranteed',
	operations: ['exec', 'files.read', 'files.write', 'files.list', 'copy'],
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

	try {
		await run(pi, context);
	} finally {
		await closeSandboxSession(pi, context);
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
		policy,
		capabilities,
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
	readonly defaultPolicy?: SandboxPolicy;
	readonly policies?: SupportedSandboxPolicies;
	readonly relationship?: SandboxWorkspace['relationship'];
}

function registerCopyProvider(pi: SandboxHost, options?: CopyProviderOptions) {
	const template = new MemoryBackend();
	const copies: { source: SandboxCopySource; policy: SandboxPolicy }[] = [];
	const released: string[] = [];
	const opened: SandboxBackend[] = [];
	const provider: SandboxProvider<object> = {
		id: 'active',
		label: 'active',
		defaultPolicy: options?.defaultPolicy ?? template.policy,
		capabilities,
		policies: options?.policies ?? ALL_POLICIES,
		validateConfig: () => ({}),
		open: (request) => {
			const backend = backendFor(
				template,
				'ordinary',
				request.policy,
				'remote'
			);

			opened.push(backend);

			return Promise.resolve(backend);
		},
		copy: (request) => {
			copies.push({ source: request.source, policy: request.policy });

			const id = 'copy-' + String(copies.length);

			return Promise.resolve(
				backendFor(
					template,
					id,
					request.policy,
					options?.relationship ?? 'copied',
					() => {
						released.push(id);
					}
				)
			);
		}
	};

	registerSandboxProvider(pi, import.meta.filename, provider);

	return { copies, released, opened };
}

it('copies a sandbox into private allocations with the strictest supported policy', async () => {
	await fixture(async (pi, context) => {
		const { copies, released, opened } = registerCopyProvider(pi);
		const target = await getSandbox(pi, context);
		const first = await target.copy();
		const second = await target.copy();
		const strictest = {
			workspaceRelationship: 'copied',
			workspaceAccess: 'read-only',
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		};

		expect({
			copies,
			sandboxes: [first.sandbox, second.sandbox].map((sandbox) => ({
				backendId: sandbox.backendId,
				relationship: sandbox.workspace.relationship,
				policy: sandbox.policy
			}))
		}).toStrictEqual({
			copies: [0, 1].map(() => ({
				source: { kind: 'backend', backend: opened[0] },
				policy: strictest
			})),
			sandboxes: ['copy-1', 'copy-2'].map((backendId) => ({
				backendId,
				relationship: 'copied',
				policy: strictest
			}))
		});

		await first.close();
		await expect(first.sandbox.files.readFile('file')).rejects.toMatchObject({
			name: 'SandboxSessionClosingError'
		});
		expect(released).toStrictEqual(['copy-1']);
		await closeSandboxSession(pi, context);
		await expect(second.close()).resolves.toMatchObject({ confirmed: true });
		expect(released).toStrictEqual(['copy-1', 'copy-2']);
	});
});

it.each([
	[
		'writes and network access',
		{ needs: ['workspace-writes', 'network'] },
		{
			workspaceAccess: 'read-write',
			filesystemScope: 'workspace-only',
			networkAccess: 'provider-default'
		}
	],
	[
		'host system files',
		{ needs: ['host-system-files'] },
		{
			workspaceAccess: 'read-only',
			filesystemScope: 'system-read-only',
			networkAccess: 'denied'
		}
	]
] as const)(
	'loosens a copy only for a need for %s',
	async (_, options, expected) => {
		await fixture(async (pi, context) => {
			const { copies } = registerCopyProvider(pi);
			const target = await getSandbox(pi, context);
			const copy = await target.copy(options);

			expect({
				requested: copies.map(({ policy }) => policy),
				effective: copy.sandbox.policy
			}).toStrictEqual({
				requested: [{ workspaceRelationship: 'copied', ...expected }],
				effective: { workspaceRelationship: 'copied', ...expected }
			});
		});
	}
);

it('limits needs in a copy of a copy by the configured policy', async () => {
	await fixture(async (pi, context) => {
		const { copies } = registerCopyProvider(pi);
		const target = await getSandbox(pi, context);
		const first = await target.copy();
		const nested = await first.sandbox.copy({ needs: ['workspace-writes'] });
		const writable = {
			workspaceRelationship: 'copied',
			workspaceAccess: 'read-write',
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		};

		const source = copies[1]?.source;

		expect({
			source: source?.kind === 'backend' ? source.backend.id : source,
			requested: copies[1]?.policy,
			effective: nested.sandbox.policy
		}).toStrictEqual({
			source: 'copy-1',
			requested: writable,
			effective: writable
		});
	});
});

it('rejects a copy of a closed sandbox through the returned promise', async () => {
	await fixture(async (pi, context) => {
		registerCopyProvider(pi);

		const target = await getSandbox(pi, context);
		let copying: Promise<unknown> | undefined;

		await closeSandboxSession(pi, context);
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
				filesystemScope: ['provider-default', 'system-read-only']
			}
		});

		const target = await getSandbox(pi, context);
		const copy = await target.copy({ guarantees: ['no-host-user-data'] });

		expect(copy.sandbox.policy.filesystemScope).toBe('system-read-only');
	});
});

it('applies session-wide requirements to copies', async () => {
	await fixture(async (pi, context) => {
		registerCopyProvider(pi);
		registerSandboxRequirement(pi, import.meta.filename, {
			needs: ['workspace-writes']
		});

		const target = await getSandbox(pi, context);
		const copy = await target.copy();

		expect(copy.sandbox.policy.workspaceAccess).toBe('read-write');
	});
});

it.each<{
	readonly name: string;
	readonly provider?: CopyProviderOptions;
	readonly requirement?: SandboxRequirements;
	readonly options: Parameters<
		Awaited<ReturnType<typeof getSandbox>>['copy']
	>[0];
}>([
	{
		name: 'a need for access that the session policy does not grant',
		provider: {
			defaultPolicy: {
				workspaceAccess: 'read-write',
				filesystemScope: 'provider-default',
				networkAccess: 'denied'
			}
		},
		options: { needs: ['network'] }
	},
	{
		name: 'a guarantee that the provider cannot provide',
		provider: {
			policies: { ...ALL_POLICIES, filesystemScope: ['provider-default'] }
		},
		options: { guarantees: ['no-host-user-data'] }
	},
	{
		name: 'a session-wide requirement for a shared workspace',
		requirement: { workspaceRelationship: 'shared' },
		options: {}
	}
])('rejects $name before copying', async (scenario) => {
	await fixture(async (pi, context) => {
		const { copies } = registerCopyProvider(pi, scenario.provider);

		if (scenario.requirement !== undefined) {
			registerSandboxRequirement(
				pi,
				import.meta.filename,
				scenario.requirement
			);
		}

		await expect(
			copyHostWorkspace(pi, context, scenario.options)
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
			ensureSandboxService(pi).copy(context, {
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
		const { released } = registerCopyProvider(pi, { relationship: 'remote' });
		const target = await getSandbox(pi, context);

		await expect(target.copy()).rejects.toMatchObject({
			name: 'InvalidSandboxDeclarationError',
			operation: 'open',
			providerId: 'active'
		});
		expect(released).toStrictEqual(['copy-1']);
	});
});

it('rejects copies from a provider without the copy capability', async () => {
	await fixture(async (pi, context) => {
		const backend = new MemoryBackend();

		registerSandboxProvider(pi, import.meta.filename, {
			id: 'ordinary',
			label: 'ordinary',
			defaultPolicy: backend.policy,
			capabilities: backend.capabilities,
			policies: {
				workspaceAccess: ['read-write'],
				filesystemScope: ['provider-default'],
				networkAccess: ['provider-default']
			},
			validateConfig: () => ({}),
			open: () => Promise.resolve(backend)
		});

		const target = await getSandbox(pi, context);

		await expect(target.copy()).rejects.toMatchObject({
			name: 'UnsupportedSandboxCapabilityError',
			operation: 'acquire',
			providerId: 'ordinary'
		});
		await expect(copyHostWorkspace(pi, context)).rejects.toMatchObject({
			name: 'UnsupportedSandboxCapabilityError',
			operation: 'acquire',
			providerId: 'ordinary'
		});
	});
});

it.each([
	['declares copy without implementing it', true, false],
	['implements copy without declaring it', false, true]
])('rejects a provider that %s', async (_, declared, implemented) => {
	await fixture((pi) => {
		const backend = new MemoryBackend();

		expect(() => {
			registerSandboxProvider(pi, import.meta.filename, {
				id: 'inconsistent',
				label: 'inconsistent',
				defaultPolicy: backend.policy,
				capabilities: {
					...backend.capabilities,
					operations: declared
						? [...backend.capabilities.operations, 'copy']
						: backend.capabilities.operations
				},
				policies: {
					workspaceAccess: ['read-write'],
					filesystemScope: ['provider-default'],
					networkAccess: ['provider-default']
				},
				validateConfig: () => ({}),
				open: () => Promise.resolve(backend),
				...(implemented && { copy: () => Promise.resolve(backend) })
			});
		}).toThrow(
			expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
		);

		return Promise.resolve();
	});
});

it('retains the entire close report when an independent broker returns an unusable copy', async () => {
	await fixture(async (pi, context) => {
		const reply = brokerReply();
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

		Object.assign(reply.service, {
			copy: () =>
				Promise.resolve({
					sandbox: {
						providerId: 'independent',
						backendId: 'remaining',
						workspace: { relationship: 'remote' },
						capabilities: { processKinds: [], operations: [], shells: [] }
					},
					close: () => Promise.resolve(report)
				})
		});
		respond(pi.events, 'pi-byos:runtime', reply);

		const [outcome] = await Promise.allSettled([
			copyHostWorkspace(pi, context, { capabilities: ['exec'] })
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
});
