import type {
	SandboxAcquireOptions,
	SandboxCapabilities,
	SandboxGuarantee,
	SandboxPolicy
} from './contracts.js';
import {
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { selectFilesystemScope } from './filesystem-scope.js';
import { hasRequiredGuarantees } from './guarantees.js';
import type { ProviderInfo } from './protocol.js';
import {
	canProtectWorkspace,
	snapshotWorkspaceProtection
} from './workspace-protection.js';

interface NegotiationIdentity {
	readonly operation: 'acquire';
	readonly providerId: string;
}

/**
The policy requirements of one acquisition or session-wide registration.
*/
export type PolicyRequirement = Pick<
	SandboxAcquireOptions,
	'guarantees' | 'needs' | 'workspaceRelationship' | 'workspaceProtection'
>;

function requiredScope(
	guarantees: readonly SandboxGuarantee[]
): SandboxPolicy['filesystemScope'] | undefined {
	if (guarantees.includes('no-host-system-files')) {
		return 'workspace-only';
	}

	return guarantees.includes('no-host-user-data')
		? 'system-read-only'
		: undefined;
}

/**
Tighten the configured policy until it provides every required guarantee. The
result keeps the configured access wherever no guarantee removes it. A need for
access that the configured policy does not grant, or that a required guarantee
removes, rejects the acquisition.
*/
export function resolvePolicy(
	personal: SandboxPolicy,
	provider: ProviderInfo,
	requested: PolicyRequirement | undefined,
	identity: NegotiationIdentity
): SandboxPolicy {
	const guarantees = requested?.guarantees ?? [];
	const needs = requested?.needs ?? [];
	const workspaceRelationship =
		requested?.workspaceRelationship ?? personal.workspaceRelationship;

	if (
		workspaceRelationship !== undefined &&
		((personal.workspaceRelationship !== undefined &&
			personal.workspaceRelationship !== workspaceRelationship) ||
			!provider.policies.workspaceRelationship?.includes(workspaceRelationship))
	) {
		throw new UnsupportedSandboxPolicyError(identity);
	}

	if (!hasRequiredGuarantees(personal, [], needs)) {
		throw new UnsupportedSandboxPolicyError(identity);
	}

	const filesystemScope = selectFilesystemScope(
		personal.filesystemScope,
		requiredScope(guarantees),
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
		...(workspaceRelationship !== undefined && { workspaceRelationship }),
		...(protection.length > 0 && { workspaceProtection: protection }),
		workspaceAccess: guarantees.includes('no-workspace-writes')
			? 'read-only'
			: personal.workspaceAccess,
		filesystemScope,
		networkAccess: guarantees.includes('no-network')
			? 'denied'
			: personal.networkAccess
	});

	if (
		!hasRequiredGuarantees(policy, guarantees, needs) ||
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
		policy.workspaceRelationship,
		policy.workspaceAccess,
		policy.filesystemScope,
		policy.networkAccess,
		snapshotWorkspaceProtection(policy.workspaceProtection ?? [])
	]);
}
