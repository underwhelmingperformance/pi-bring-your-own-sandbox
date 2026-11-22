import type {
	SandboxAccess,
	SandboxGuarantee,
	SandboxPolicy
} from './contracts.js';

type FilesystemScope = SandboxPolicy['filesystemScope'];

const opposites: Readonly<Record<SandboxAccess, SandboxGuarantee>> = {
	'workspace-writes': 'no-workspace-writes',
	network: 'no-network',
	'host-user-data': 'no-host-user-data',
	'host-system-files': 'no-host-system-files'
};

const scopeGuarantees: Readonly<
	Record<FilesystemScope, readonly SandboxGuarantee[]>
> = {
	'provider-default': [],
	'system-read-only': ['no-host-user-data'],
	'workspace-only': ['no-host-user-data', 'no-host-system-files']
};

/**
The guarantees that a policy's workspace access, filesystem scope and network
access provide.
*/
export function policyGuarantees(
	policy: Pick<
		SandboxPolicy,
		'workspaceAccess' | 'filesystemScope' | 'networkAccess'
	>
): ReadonlySet<SandboxGuarantee> {
	return new Set([
		...(policy.workspaceAccess === 'read-only'
			? (['no-workspace-writes'] as const)
			: []),
		...scopeGuarantees[policy.filesystemScope],
		...(policy.networkAccess === 'denied' ? (['no-network'] as const) : [])
	]);
}

/**
The guarantees that the given needs rule out.
*/
export function excludedGuarantees(
	needs: readonly SandboxAccess[]
): ReadonlySet<SandboxGuarantee> {
	return new Set(needs.map((need) => opposites[need]));
}

/**
Whether a policy provides every required guarantee and none that the needs rule
out.
*/
export function hasRequiredGuarantees(
	policy: Pick<
		SandboxPolicy,
		'workspaceAccess' | 'filesystemScope' | 'networkAccess'
	>,
	guarantees: readonly SandboxGuarantee[],
	needs: readonly SandboxAccess[]
): boolean {
	const provided = policyGuarantees(policy);

	return (
		guarantees.every((guarantee) => provided.has(guarantee)) &&
		excludedGuarantees(needs)
			.values()
			.every((guarantee) => !provided.has(guarantee))
	);
}
