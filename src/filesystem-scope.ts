import type { SandboxPolicy } from './contracts.js';

type FilesystemScope = SandboxPolicy['filesystemScope'];

const strength: Readonly<Record<FilesystemScope, number>> = {
	'provider-default': 0,
	'system-read-only': 1,
	'workspace-only': 2
};

export function isFilesystemScopeSatisfied(
	effective: FilesystemScope,
	required: FilesystemScope
): boolean {
	return strength[effective] >= strength[required];
}

export function selectFilesystemScope(
	personal: FilesystemScope,
	requested: FilesystemScope | undefined,
	supported: readonly FilesystemScope[]
): FilesystemScope | undefined {
	const required =
		requested === undefined || isFilesystemScopeSatisfied(personal, requested)
			? personal
			: requested;

	return supported
		.toSorted((left, right) => strength[left] - strength[right])
		.find((scope) => isFilesystemScopeSatisfied(scope, required));
}
