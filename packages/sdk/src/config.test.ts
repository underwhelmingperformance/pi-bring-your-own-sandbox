import { expect, it } from 'vitest';

import { resolveSandboxConfig, selectProvider } from './config.js';
import {
	ProviderNotFoundError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { fixtureProfile } from './fixtures/profile-fixture.js';
import { defaultPolicy, unrestrictedPolicy } from './policy-model.js';
import type { ProviderServiceV1 } from './protocol.js';

const backend = new MemoryBackend('exec');
const open = (policy = defaultPolicy) =>
	fixtureProfile(policy, backend.capabilities);
const provider: ProviderServiceV1 = {
	id: 'fixture',
	label: 'Fixture',
	profiles: { open: [open(), open(unrestrictedPolicy)], copy: [] },
	configure: () => ({ open: () => Promise.resolve(backend) })
};

it('uses the SDK default and keeps the provider configuration separate', () => {
	const config = { image: 'fixture' };

	expect(
		resolveSandboxConfig(provider, { configuration: config }, 'extension')
	).toStrictEqual({
		allowEscalation: true,
		selection: {
			providerId: 'fixture',
			source: 'extension',
			policy: defaultPolicy
		},
		providerConfig: config,
		providerConfigSource: 'extension'
	});
});

it('narrows an omitted policy to the best supported profile', () => {
	const restricted = { ...defaultPolicy, hostSystemFiles: 'denied' as const };
	const candidate = {
		...provider,
		profiles: { open: [open(restricted)], copy: [] }
	};

	expect(
		resolveSandboxConfig(candidate, { configuration: {} }, 'extension')
	).toStrictEqual({
		allowEscalation: true,
		selection: {
			providerId: 'fixture',
			source: 'extension',
			policy: restricted
		},
		providerConfig: {},
		providerConfigSource: 'extension'
	});
});

it('uses an explicit policy as the limit and snapshots shared settings', () => {
	const policy = { ...unrestrictedPolicy };
	const result = resolveSandboxConfig(
		provider,
		{
			configuration: {},
			settings: {
				policy,
				allowEscalation: false,
				userShell: 'bash',
				cleanup: { disposalTimeoutMs: 300 }
			}
		},
		'extension'
	);

	policy.network = false;

	expect(result).toStrictEqual({
		allowEscalation: false,
		selection: {
			providerId: 'fixture',
			source: 'extension',
			policy: unrestrictedPolicy,
			userShell: 'bash'
		},
		providerConfig: {},
		providerConfigSource: 'extension',
		policySource: 'extension',
		cleanup: { disposalTimeoutMs: 300 }
	});
});

it('rejects a provider that supports no profile within the configured limit', () => {
	const candidate = {
		...provider,
		profiles: { open: [open(unrestrictedPolicy)], copy: [] }
	};

	expect(() =>
		resolveSandboxConfig(candidate, { configuration: {} }, 'extension')
	).toThrow(UnsupportedSandboxPolicyError);
});

it('refuses to select a missing provider', () => {
	const config = resolveSandboxConfig(
		provider,
		{ configuration: {} },
		'extension'
	);

	expect(() => selectProvider(config, [])).toThrow(ProviderNotFoundError);
});
