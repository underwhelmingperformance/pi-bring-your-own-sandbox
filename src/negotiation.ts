import type {
	SandboxAcquireOptions,
	SandboxCapabilities,
	SandboxPolicy
} from './contracts.js';
import {
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { selectFilesystemScope } from './filesystem-scope.js';
import type { ProviderInfo } from './protocol.js';
import {
	canProtectWorkspace,
	snapshotWorkspaceProtection
} from './workspace-protection.js';

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

	const filesystemScope = selectFilesystemScope(
		personal.filesystemScope,
		requested?.filesystemScope,
		provider.policies.filesystemScope
	);

	if (filesystemScope === undefined) {
		throw new UnsupportedSandboxPolicyError(identity);
	}

	const protection = snapshotWorkspaceProtection([
		...(personal.workspaceProtection ?? []),
		...(requested?.workspaceProtection ?? [])
	]);

	const policy: SandboxPolicy = Object.freeze({
		...(protection.length > 0 && { workspaceProtection: protection }),
		workspaceAccess: requested?.workspaceAccess ?? personal.workspaceAccess,
		filesystemScope,
		networkAccess:
			requested?.networkAccess === 'denied' ? 'denied' : personal.networkAccess
	});

	if (
		!canProtectWorkspace(provider.capabilities, policy) ||
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
	return JSON.stringify([
		policy.workspaceAccess,
		policy.filesystemScope,
		policy.networkAccess,
		snapshotWorkspaceProtection(policy.workspaceProtection ?? [])
	]);
}
