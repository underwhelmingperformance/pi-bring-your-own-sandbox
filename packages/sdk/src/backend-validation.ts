import { homedir, platform } from 'node:os';
import path from 'node:path';

import { backendSchema, isAbsoluteWorkspacePath } from './backend-schemas.js';
import type {
	SandboxBackend,
	SandboxOperationContext,
	SandboxWorkspace
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { canonicalHostPath, hostPathComparisonKey } from './host-paths.js';
import type { Profile } from './policy-model.js';
import { profileKey } from './policy-model.js';
import type { ProfileMode, ResolvedPath } from './profile-negotiation.js';
import type { ProviderServiceV1 } from './protocol.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

const isBackend = checker(backendSchema);

function hasInvalidHostUserDataRoot(
	workspace: Record<string, unknown>,
	profile: Profile
): boolean {
	const root = workspace['hostUserDataRoot'];
	const isMustReportRoot = profile.policy.hostUserData !== 'denied';

	if (root === undefined) {
		return isMustReportRoot;
	}

	const flavor = workspace['pathFlavor'];

	return (
		!isMustReportRoot ||
		((flavor === 'posix' || flavor === 'win32') &&
			!isAbsoluteWorkspacePath(root, flavor))
	);
}

export function validateBackend(
	value: unknown,
	provider: Pick<ProviderServiceV1, 'id' | 'protocol'>,
	required: Profile,
	mode: ProfileMode = 'open',
	hostUserDataRoots?: readonly string[]
): SandboxBackend {
	const extensionSource = provider.protocol?.extensionSource;
	const identity = {
		operation: 'open' as const,
		providerId: provider.id,
		...(extensionSource !== undefined && { extensionSource })
	};

	if (
		isRecord(value) &&
		isRecord(value['workspace']) &&
		hasInvalidHostUserDataRoot(value['workspace'], required)
	) {
		throw new InvalidSandboxDeclarationError({
			...identity,
			...(typeof value['id'] === 'string' && { backendId: value['id'] }),
			detail: { kind: 'declaration', field: 'workspace.hostUserDataRoot' }
		});
	}

	if (!isBackend(value)) {
		throw new InvalidSandboxDeclarationError({
			...identity,
			detail: { kind: 'declaration', field: 'backend' }
		});
	}

	const workspace = mode === 'copy' ? 'copied' : 'shared';

	const hasWrongWorkspace = value.workspace.relationship !== workspace;

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

	const enforced = value.hostUserDataRoots;
	const areRootsEqual =
		hostUserDataRoots === undefined
			? enforced === undefined
			: enforced?.length === hostUserDataRoots.length &&
				hostUserDataRoots.every((root) => enforced.includes(root));

	if (!areRootsEqual) {
		throw new InvalidSandboxDeclarationError({
			...identity,
			backendId: value.id,
			detail: { kind: 'declaration', field: 'hostUserDataRoots' }
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
	const host = platform();
	const comparedHome = hostPathComparisonKey(hostHome, host);
	const comparedPath = hostPathComparisonKey(hostPath, host);

	if (!isWithinTarget(comparedHome, comparedPath, path)) {
		return flavor.isAbsolute(hostPath) ? flavor.normalize(hostPath) : undefined;
	}

	if (workspace.home === undefined || !flavor.isAbsolute(workspace.home)) {
		return undefined;
	}

	const relative = path.relative(comparedHome, comparedPath);

	return flavor.resolve(workspace.home, ...relative.split(path.sep));
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
			? await canonicalHostPath(homedir())
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
