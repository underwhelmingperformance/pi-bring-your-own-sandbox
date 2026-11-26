import { expect, it } from 'vitest';

import { formatProviders, formatStatus } from './diagnostics.js';
import { SandboxStartupError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import type { ProviderInfo } from './protocol.js';

it('shows a configured shell that the ready backend does not support', () => {
	const backend = new MemoryBackend();

	expect(
		formatStatus({
			generationId: 'generation',
			state: 'ready',
			selection: {
				providerId: 'fixture',
				source: 'extension',
				policy: backend.policy,
				userShell: 'powershell'
			},
			backendId: backend.id,
			workspace: backend.workspace,
			capabilities: backend.capabilities,
			policy: backend.policy,
			policyDescription: backend.policyDescription
		})
	).toBe(
		[
			'Provider: fixture (extension)',
			'State: ready',
			'Generation: generation',
			'Backend: memory',
			'Target: /remote/project (remote)',
			'Effective policy: workspace read-write (remote); filesystem provider-default; network provider-default; protected resources: none',
			'Operations: exec, files.read, files.write, files.list',
			'Termination scope: workload',
			'Shells: none',
			'User shell: powershell (configured; unavailable on this backend)',
			'Boundary: In-memory test fixture; no OS isolation.'
		].join('\n')
	);
});

it('distinguishes the default policy from an explicitly acquired protected workspace', () => {
	const backend = new MemoryBackend();
	const requested = {
		...backend.policy,
		workspaceAccess: 'read-only' as const
	};

	expect(
		formatStatus({
			generationId: 'generation',
			state: 'idle',
			selection: {
				providerId: 'fixture',
				source: 'extension',
				policy: backend.policy
			},
			backends: [
				{
					backendId: 'review',
					state: 'ready',
					policy: requested,
					effectivePolicy: {
						...requested,
						workspaceRelationship: 'copied',
						workspaceProtection: [
							{ kind: 'git-metadata' },
							{ kind: 'path', path: 'policy\nfile\u{202E}\u{200B}\u{E0001}' }
						]
					}
				}
			]
		})
	).toBe(
		[
			'Provider: fixture (extension)',
			'State: idle',
			'Generation: generation',
			'Default target: not opened',
			'Requested policy: workspace read-write; filesystem provider-default; network provider-default; protected resources: none',
			'User shell: provider default (not opened)',
			'Additional backend "review" (ready)',
			'Effective policy: workspace read-only (copied); filesystem provider-default; network provider-default; protected resources: Git metadata, "policy\\nfile\\u202e\\u200b\\udb40\\udc01"'
		].join('\n')
	);
});

it.each(['closing', 'closed'] as const)(
	'keeps the base boundary with the base backend while %s',
	(state) => {
		const backend = new MemoryBackend();
		const requested = {
			...backend.policy,
			workspaceAccess: 'read-only' as const
		};
		const status = formatStatus({
			generationId: 'generation',
			state,
			selection: {
				providerId: 'fixture',
				source: 'extension',
				policy: backend.policy
			},
			backendId: backend.id,
			workspace: backend.workspace,
			policy: backend.policy,
			policyDescription: 'Base boundary.',
			backends: [
				{ policy: backend.policy, state: 'ready', backendId: backend.id },
				{ policy: requested, state: 'opening' }
			]
		});

		expect(status).toBe(
			[
				'Provider: fixture (extension)',
				'State: ' + state,
				'Generation: generation',
				'Backend: memory',
				'Target: /remote/project (remote)',
				'Effective policy: workspace read-write (remote); filesystem provider-default; network provider-default; protected resources: none',
				'User shell: unavailable',
				'Boundary: Base boundary.',
				'Additional backend (last state: opening)',
				'Requested policy: workspace read-only; filesystem provider-default; network provider-default; protected resources: none'
			].join('\n')
		);
	}
);

it('shows allocation recovery instructions and expiry when cleanup is incomplete', () => {
	const backend = new MemoryBackend();

	expect(
		formatStatus({
			generationId: 'generation',
			state: 'closed',
			selection: {
				providerId: 'fixture',
				source: 'extension',
				policy: backend.policy
			},
			closeReport: {
				confirmed: false,
				failures: [],
				recoveries: [
					{
						kind: 'allocation',
						id: 'allocation',
						lease: 'lease',
						expiresAt: '2099-01-01T00:00:00Z',
						instructions: 'Remove allocations with this lease.'
					}
				]
			}
		})
	).toBe(
		[
			'Provider: fixture (extension)',
			'State: closed',
			'Generation: generation',
			'Target: not opened',
			'Requested policy: workspace read-write; filesystem provider-default; network provider-default; protected resources: none',
			'User shell: provider default (not opened)',
			'Cleanup: incomplete',
			'Recovery: allocation (lease lease; expires 2099-01-01T00:00:00Z)',
			'Remove allocations with this lease.'
		].join('\n')
	);
});

it('shows recovery from an opening that failed before returning a backend', () => {
	const base = new MemoryBackend().policy;
	const failure = new SandboxStartupError(
		{
			operation: 'open',
			recovery: {
				kind: 'allocation',
				id: 'orphan-volume-123',
				lease: 'manual cleanup',
				instructions: 'Remove orphan-volume-123.\nCheck leases.'
			}
		},
		{ cause: new Error('PRIVATE_PROVIDER_TOKEN') }
	);

	expect(
		formatStatus({
			generationId: 'generation',
			state: 'failed',
			failure,
			selection: { providerId: 'fixture', source: 'extension', policy: base },
			backends: [
				{ policy: base, state: 'failed' },
				{ policy: { ...base, workspaceAccess: 'read-only' }, state: 'opening' }
			],
			diagnostics: [
				{
					operation: 'open',
					operationId: 'first',
					level: 'warning',
					message: 'Base opening failed.\u{1B}[8m'
				}
			]
		})
	).toBe(
		[
			'Provider: fixture (extension)',
			'State: failed',
			'Generation: generation',
			'Default target: not opened',
			'Requested policy: workspace read-write; filesystem provider-default; network provider-default; protected resources: none',
			'User shell: provider default (not opened)',
			`Failure: ${failure.name}: ${failure.message}`,
			'Cleanup: incomplete',
			'Recovery: orphan-volume-123 (lease manual cleanup)',
			String.raw`Remove orphan-volume-123.\x0aCheck leases.`,
			'Additional backend (opening)',
			'Requested policy: workspace read-only; filesystem provider-default; network provider-default; protected resources: none',
			String.raw`Warning (open, first): Base opening failed.\x1b[8m`
		].join('\n')
	);
});

it('describes arbitrary providers through declaration metadata', () => {
	const backend = new MemoryBackend('exec');
	const provider = {
		id: 'custom',
		label: 'Custom execution boundary',
		capabilities: backend.capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		}
	} satisfies ProviderInfo;

	expect(
		formatStatus({
			generationId: 'generation',
			state: 'idle',
			providerLabel: provider.label,
			selection: {
				providerId: provider.id,
				source: 'default',
				policy: backend.policy
			}
		})
	).toBe(
		[
			'Provider: custom (default)',
			'State: idle',
			'Generation: generation',
			'Target: not opened',
			'Requested policy: workspace read-write; filesystem provider-default; network provider-default; protected resources: none',
			'User shell: provider default (not opened)',
			'Provider description: Custom execution boundary'
		].join('\n')
	);
});

it('escapes controls in a provider label in the provider list', () => {
	const backend = new MemoryBackend('exec');

	expect(
		formatProviders([
			{
				id: 'custom',
				label: 'Custom\tboundary',
				capabilities: backend.capabilities,
				policies: {
					workspaceAccess: ['read-write'],
					filesystemScope: ['provider-default'],
					networkAccess: ['provider-default']
				}
			}
		])
	).toStrictEqual(
		[
			'Available sandbox providers (declared capabilities):',
			String.raw`custom: Custom\x09boundary`,
			'  Operations: exec',
			'  Termination scope: workload',
			'  Shells: none',
			'  Policies: workspace read-write; filesystem provider-default; network provider-default'
		].join('\n')
	);
});
