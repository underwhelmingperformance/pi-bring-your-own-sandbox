import type {
	SandboxCapabilities,
	SandboxPolicy,
	WorkspaceProtection
} from './contracts.js';

/**
Immutable host configuration resources for Git, Pi, direnv, editors and
container-based development tools. Add project-specific resources explicitly.
This preset does not make arbitrary writable source safe to execute on the host.
*/
export const HOST_CONFIGURATION_PROTECTION: readonly WorkspaceProtection[] =
	Object.freeze([
		Object.freeze({ kind: 'git-metadata' as const }),
		...['.pi', '.envrc', '.direnv', '.vscode', '.idea', '.devcontainer'].map(
			(path) => Object.freeze({ kind: 'path' as const, path })
		)
	]);

function key(resource: WorkspaceProtection): string {
	return resource.kind === 'git-metadata' ? '' : resource.path;
}

function isResourceCovered(
	effective: WorkspaceProtection,
	required: WorkspaceProtection
): boolean {
	return effective.kind === 'git-metadata'
		? required.kind === 'git-metadata' ||
				required.path === '.git' ||
				required.path.startsWith('.git/')
		: required.kind === 'path' &&
				(required.path === effective.path ||
					required.path.startsWith(`${effective.path}/`));
}

export function snapshotWorkspaceProtection(
	resources: readonly WorkspaceProtection[]
): readonly WorkspaceProtection[] {
	const unique = new Map(
		resources.map((resource) => [key(resource), resource])
	);

	const selected = unique
		.values()
		.filter(
			(resource) =>
				!unique
					.values()
					.some(
						(other) => other !== resource && isResourceCovered(other, resource)
					)
		)
		.toArray();

	return Object.freeze(
		selected
			.toSorted((left, right) => {
				const leftKey = key(left);
				const rightKey = key(right);

				if (leftKey === rightKey) {
					return 0;
				}

				return leftKey < rightKey ? -1 : 1;
			})
			.map((resource) =>
				Object.freeze(
					resource.kind === 'git-metadata'
						? { kind: 'git-metadata' as const }
						: { kind: 'path' as const, path: resource.path }
				)
			)
	);
}

export function canProtectWorkspace(
	capabilities: SandboxCapabilities,
	policy: SandboxPolicy
): boolean {
	return (
		(policy.workspaceProtection?.length ?? 0) === 0 ||
		((policy.workspaceProtection?.length ?? 0) <= 128 &&
			capabilities.operations.includes('workspace.protection'))
	);
}

export function isWorkspaceProtectionSatisfied(
	effective: SandboxPolicy,
	required: Partial<SandboxPolicy>
): boolean {
	return (required.workspaceProtection ?? []).every((resource) =>
		(effective.workspaceProtection ?? []).some((candidate) =>
			isResourceCovered(candidate, resource)
		)
	);
}
