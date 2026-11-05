import { expect, it } from 'vitest';

import {
	DuplicateProviderError,
	InvalidSandboxDeclarationError
} from './errors.js';
import { passthroughProvider } from './passthrough-provider.js';
import { ProviderRegistry } from './provider-registry.js';

it('derives default selection and reserved identities from registered implementations', () => {
	const provider = { ...passthroughProvider, id: 'custom-default' };
	const additional = { ...provider, id: 'another-builtin' };
	const registry = new ProviderRegistry(provider, [additional]);

	expect({
		defaultId: registry.defaultProvider.id,
		providerIds: registry.providers.map((entry) => entry.id),
		reserved: ['custom-default', 'another-builtin', 'passthrough'].map(
			(id) => ({ id, reserved: registry.has(id) })
		)
	}).toStrictEqual({
		defaultId: 'custom-default',
		providerIds: ['custom-default', 'another-builtin'],
		reserved: [
			{ id: 'custom-default', reserved: true },
			{ id: 'another-builtin', reserved: true },
			{ id: 'passthrough', reserved: false }
		]
	});
});

it('rejects duplicate built-in identities', () => {
	expect(
		() => new ProviderRegistry(passthroughProvider, [passthroughProvider])
	).toThrow(DuplicateProviderError);
});

it('validates built-in default policies against their declarations', () => {
	const provider = {
		...passthroughProvider,
		defaultPolicy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		}
	} as const;

	expect(() => new ProviderRegistry(provider)).toThrow(
		InvalidSandboxDeclarationError
	);
});
