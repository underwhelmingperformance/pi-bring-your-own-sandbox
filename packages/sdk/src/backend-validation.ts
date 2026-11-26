import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { backendSchema } from './backend-schemas.js';
import type {
	SandboxBackend,
	SandboxOperationContext,
	SandboxWorkspace
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { Profile } from './policy-model.js';
import { profileKey } from './policy-model.js';
import type { ProfileMode, ResolvedPath } from './profile-negotiation.js';
import type { ProviderServiceV1 } from './protocol.js';
import { checker } from './schemas.js';

const isBackend = checker(backendSchema);

export function validateBackend(
	value: unknown,
	provider: Pick<ProviderServiceV1, 'id' | 'protocol'>,
	required: Profile,
	mode: ProfileMode | 'outside' = 'open'
): SandboxBackend {
	const extensionSource = provider.protocol?.extensionSource;
	const identity = {
		operation: 'open' as const,
		providerId: provider.id,
		...(extensionSource !== undefined && { extensionSource })
	};

	if (!isBackend(value)) {
		throw new InvalidSandboxDeclarationError({
			...identity,
			detail: { kind: 'declaration', field: 'backend' }
		});
	}

	const workspace = mode === 'copy' ? 'copied' : 'shared';

	const hasWrongWorkspace =
		mode !== 'outside' && value.workspace.relationship !== workspace;

	if (hasWrongWorkspace || profileKey(value.profile) !== profileKey(required)) {
		throw new InvalidSandboxDeclarationError({
			...identity,
			backendId: value.id,
			detail: {
				kind: 'declaration',
				field: hasWrongWorkspace ? 'workspace.relationship' : 'profile'
			}
		});
	}

	return value;
}

function isWithinTarget(
	root: string,
	target: string,
	flavor: typeof path.posix
): boolean {
	const relative = flavor.relative(root, target);

	return (
		relative !== '..' &&
		!relative.startsWith('..' + flavor.sep) &&
		!flavor.isAbsolute(relative)
	);
}

function extraTarget(
	hostPath: string,
	hostHome: string,
	workspace: SandboxWorkspace
): string | undefined {
	const flavor = path[workspace.pathFlavor];

	if (!isWithinTarget(hostHome, hostPath, path)) {
		return flavor.isAbsolute(hostPath) ? flavor.normalize(hostPath) : undefined;
	}

	if (workspace.home === undefined || !flavor.isAbsolute(workspace.home)) {
		return undefined;
	}

	const relative = path.relative(hostHome, hostPath);

	return flavor.resolve(workspace.home, ...relative.split(path.sep));
}

async function canonicalHostHome(): Promise<string> {
	const home = homedir();

	try {
		return await realpath(home);
	} catch {
		return home;
	}
}

export async function verifyGrantedPaths(
	backend: SandboxBackend,
	requested: readonly ResolvedPath[],
	context: SandboxOperationContext,
	provider: Pick<ProviderServiceV1, 'id' | 'protocol'>,
	isEscalated = false
): Promise<void> {
	const extensionSource = provider.protocol?.extensionSource;
	const identity = {
		operation: 'open' as const,
		providerId: provider.id,
		backendId: backend.id,
		...(extensionSource !== undefined && { extensionSource })
	};
	const grants = backend.grantedPaths ?? [];
	const flavor = path[backend.workspace.pathFlavor];
	const hostHome =
		isEscalated && requested.some(({ location }) => location !== 'workspace')
			? await canonicalHostHome()
			: undefined;

	for (const request of requested) {
		const matches = grants.filter(
			(grant) => grant.kind === request.kind && grant.hostPath === request.path
		);
		const [grant] = matches;

		function unreachable(cause?: unknown): never {
			throw new UnsupportedSandboxPolicyError(
				{
					...identity,
					detail: {
						kind: 'path',
						access: request.kind,
						path: request.path,
						reason: 'unreachable'
					}
				},
				{ cause }
			);
		}

		const isWorkspace = request.location === 'workspace';

		if (
			grant === undefined ||
			matches.length !== 1 ||
			!flavor.isAbsolute(grant.targetPath) ||
			(isWorkspace &&
				!isWithinTarget(backend.workspace.root, grant.targetPath, flavor)) ||
			(hostHome !== undefined &&
				!isWorkspace &&
				flavor.normalize(grant.targetPath) !==
					extraTarget(request.path, hostHome, backend.workspace))
		) {
			unreachable();
		}

		const files = backend.files?.[request.kind];

		if (files !== undefined) {
			try {
				await files.access(grant.targetPath, context);
			} catch (error) {
				unreachable(error);
			}
		}
	}

	if (grants.length !== requested.length) {
		throw new InvalidSandboxDeclarationError({
			...identity,
			detail: { kind: 'declaration', field: 'grantedPaths' }
		});
	}
}
