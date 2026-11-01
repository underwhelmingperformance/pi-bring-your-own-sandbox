import { Type } from 'typebox';
import { Value } from 'typebox/value';

import {
	providerBackendSchema,
	requiredPolicySchema,
	workspaceSchema
} from './backend-schemas.js';
import type {
	SandboxBackend,
	SandboxCapabilities,
	SandboxPolicy,
	SandboxWorkspace
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { ProviderInfo } from './protocol.js';

export function isWorkspace(
	value: unknown,
	capabilities: SandboxCapabilities
): value is SandboxWorkspace {
	const schema = Type.Refine(
		workspaceSchema,
		(workspace) =>
			workspace.defaultShell === undefined ||
			capabilities.shells.includes(workspace.defaultShell)
	);

	return Value.Check(schema, value);
}

export function isPolicySatisfied(
	effective: SandboxPolicy,
	required: Partial<SandboxPolicy>
): boolean {
	return Value.Check(requiredPolicySchema(required), effective);
}

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

	if (!isPolicySatisfied(value.policy, required)) {
		throw new UnsupportedSandboxPolicyError({
			operation: 'open',
			providerId: provider.id,
			backendId: value.id
		});
	}

	return value;
}
