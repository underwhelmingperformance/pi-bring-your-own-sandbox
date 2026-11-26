import { Value } from 'typebox/value';

import {
	providerBackendSchema,
	requiredPolicySchema
} from './backend-schemas.js';
import type { SandboxBackend, SandboxPolicy } from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { ProviderInfo } from './protocol.js';

export function validateBackend(
	value: unknown,
	provider: ProviderInfo,
	required: SandboxPolicy
): SandboxBackend {
	if (!Value.Check(providerBackendSchema(provider), value)) {
		throw new InvalidSandboxDeclarationError({
			operation: 'open',
			providerId: provider.id
		});
	}

	if (
		!Value.Check(requiredPolicySchema(required), {
			...value.policy,
			workspaceRelationship: value.workspace.relationship
		})
	) {
		throw new UnsupportedSandboxPolicyError({
			operation: 'open',
			providerId: provider.id,
			backendId: value.id
		});
	}

	return value;
}
