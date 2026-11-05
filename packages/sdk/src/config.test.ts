import { expect, it } from 'vitest';

import { resolveSandboxConfig, selectProvider } from './config.js';
import type { ProviderServiceV1 } from './protocol.js';

const defaultPolicy = {
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
} as const;
const isolatedPolicy = {
	...defaultPolicy,
	filesystemScope: 'workspace-only',
	networkAccess: 'denied'
} as const;

function service(id: string): ProviderServiceV1 {
	return {
		id,
		label: id,
		capabilities: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: []
		},
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		configure: () => ({
			open: () => Promise.reject(new Error('Selection must not allocate.'))
		})
	};
}

it.each([
	{
		selection: {
			providerId: 'missing',
			source: 'extension',
			policy: defaultPolicy
		},
		name: 'ProviderNotFoundError'
	},
	{
		selection: {
			providerId: 'passthrough',
			source: 'extension',
			policy: isolatedPolicy
		},
		name: 'UnsupportedSandboxPolicyError'
	}
] as const)(
	'rejects an unsatisfied selection without a host fallback: $name',
	({ selection, name }) => {
		expect(() =>
			selectProvider({ selection, providerConfig: {} }, [
				service('passthrough')
			])
		).toThrow(expect.objectContaining({ name }));
	}
);

it('uses the declared default policy and preserves typed configuration', () => {
	const provider = { ...service('fixture'), defaultPolicy };
	const config = { image: 'selected' };

	expect(
		resolveSandboxConfig(provider, { configuration: config }, 'extension')
	).toStrictEqual({
		selection: {
			providerId: 'fixture',
			source: 'extension',
			policy: defaultPolicy
		},
		providerConfig: config,
		providerConfigSource: 'extension'
	});
});
it('requires a policy when the provider has no default', () => {
	expect(() =>
		resolveSandboxConfig(service('fixture'), { configuration: {} }, 'extension')
	).toThrow(expect.objectContaining({ name: 'InvalidSandboxConfigError' }));
});
it('uses a complete supplied policy and snapshots its protected resources', () => {
	const resources = [{ kind: 'git-metadata' as const }];
	const result = resolveSandboxConfig(
		{ ...service('fixture'), defaultPolicy },
		{
			configuration: {},
			policy: { ...isolatedPolicy, workspaceProtection: resources },
			userShell: 'sh',
			cleanup: { cancellationGraceMs: 8000 }
		},
		'extension'
	);

	resources.push({ kind: 'git-metadata' });
	expect(result).toStrictEqual({
		selection: {
			providerId: 'fixture',
			source: 'extension',
			policy: {
				...isolatedPolicy,
				workspaceProtection: [{ kind: 'git-metadata' }]
			},
			userShell: 'sh'
		},
		providerConfig: {},
		providerConfigSource: 'extension',
		policySource: 'extension',
		cleanup: { cancellationGraceMs: 8000 }
	});
});
