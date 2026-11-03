import type {
	SandboxAcquireOptions,
	SandboxCapabilities,
	SandboxPolicy
} from './contracts.js';
import {
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { ProviderInfo } from './protocol.js';

interface NegotiationIdentity {
	readonly operation: 'acquire';
	readonly providerId: string;
}

export function resolvePolicy(
	personal: SandboxPolicy,
	provider: ProviderInfo,
	requested: Partial<SandboxPolicy> | undefined,
	identity: NegotiationIdentity
): SandboxPolicy {
	if (
		requested?.workspaceAccess === 'read-write' &&
		personal.workspaceAccess === 'read-only'
	) {
		throw new UnsupportedSandboxPolicyError(identity);
	}

	const policy: SandboxPolicy = Object.freeze({
		workspaceAccess: requested?.workspaceAccess ?? personal.workspaceAccess,
		filesystemScope:
			requested?.filesystemScope === 'workspace-only'
				? 'workspace-only'
				: personal.filesystemScope,
		networkAccess:
			requested?.networkAccess === 'denied' ? 'denied' : personal.networkAccess
	});

	if (
		!provider.policies.workspaceAccess.includes(policy.workspaceAccess) ||
		!provider.policies.filesystemScope.includes(policy.filesystemScope) ||
		!provider.policies.networkAccess.includes(policy.networkAccess)
	) {
		throw new UnsupportedSandboxPolicyError(identity);
	}

	return policy;
}

// Exit status and termination scope are checked only after opening, because an
// opened backend may strengthen its provider's declaration.
export function checkDeclaredCapabilities(
	declared: SandboxCapabilities,
	options: SandboxAcquireOptions,
	identity: NegotiationIdentity
): void {
	if (
		options.capabilities?.some(
			(capability) => !declared.operations.includes(capability)
		) ||
		options.processKinds?.some(
			(kind) => !declared.processKinds.includes(kind)
		) ||
		options.shells?.some((shell) => !declared.shells.includes(shell))
	) {
		throw new UnsupportedSandboxCapabilityError(identity);
	}
}

export function policyKey(policy: SandboxPolicy): string {
	return `${policy.workspaceAccess}/${policy.filesystemScope}/${policy.networkAccess}`;
}
