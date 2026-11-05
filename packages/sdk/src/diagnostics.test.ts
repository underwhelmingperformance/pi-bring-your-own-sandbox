import { expect, it } from 'vitest';

import { formatStatus } from './diagnostics.js';
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
			'Effective policy: workspace read-write; filesystem provider-default; network provider-default',
			'Operations: exec, files.read, files.write, files.list',
			'Termination scope: workload',
			'Shells: none',
			'User shell: powershell (configured; unavailable on this backend)',
			'Boundary: In-memory test fixture; no OS isolation.'
		].join('\n')
	);
});

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
			'Requested policy: workspace read-write; filesystem provider-default; network provider-default',
			'User shell: provider default (not opened)',
			'Cleanup: incomplete',
			'Recovery: allocation (lease lease; expires 2099-01-01T00:00:00Z)',
			'Remove allocations with this lease.'
		].join('\n')
	);
});

it('shows recovery from an opening that failed before returning a backend', () => {
	const failure = new SandboxStartupError(
		{
			operation: 'open',
			recovery: {
				kind: 'allocation',
				id: 'orphan-volume-123',
				lease: 'manual cleanup',
				instructions: 'Remove orphan-volume-123.'
			}
		},
		{ cause: new Error('PRIVATE_PROVIDER_TOKEN') }
	);

	expect(
		formatStatus({ generationId: 'generation', state: 'failed', failure })
	).toBe(
		[
			'Provider: unavailable',
			'State: failed',
			'Generation: generation',
			'Target: not opened',
			'User shell: provider default (not opened)',
			`Failure: ${failure.name}: ${failure.message}`,
			'Cleanup: incomplete',
			'Recovery: orphan-volume-123 (lease manual cleanup)',
			'Remove orphan-volume-123.'
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
			'Requested policy: workspace read-write; filesystem provider-default; network provider-default',
			'User shell: provider default (not opened)',
			'Provider description: Custom execution boundary'
		].join('\n')
	);
});
