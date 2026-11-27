import { homedir, platform } from 'node:os';
import path from 'node:path';

import { resolveCredentialExclusions } from './credential-locations.js';
import { UnsupportedSandboxPolicyError } from './errors.js';
import {
	canonicalHostPath,
	classifyHostPath,
	isWithinHostRoots
} from './host-paths.js';
import { hostToolchainRoots } from './host-toolchain-roots.js';
import type { PathGrants } from './policy-model.js';
import type { ResolvedPath } from './profile-negotiation.js';

function isHomeRelative(input: string): boolean {
	return (
		input === '~' ||
		input.startsWith('~/') ||
		(path.sep === '\\' && input.startsWith('~\\'))
	);
}

function hostPath(workspace: string, input: string): string {
	if (isHomeRelative(input)) {
		return input === '~' ? homedir() : homedir() + path.sep + input.slice(2);
	}

	if (path.sep === '\\') {
		return path.resolve(workspace, input);
	}

	return path.isAbsolute(input) ? input : workspace + path.sep + input;
}

export async function resolveHostUserDataRoots(
	settings: readonly string[] = []
): Promise<readonly string[]> {
	const host = platform();
	const builtIn =
		host === 'darwin' || host === 'linux' ? hostToolchainRoots[host] : [];

	const roots = await Promise.all(
		[...builtIn, ...settings].map((root) => resolveReadRoot(root))
	);

	return Object.freeze([...new Set(roots)]);
}

export async function resolveReadRoot(root: string): Promise<string> {
	if (isHomeRelative(root)) {
		return canonicalHostPath(hostPath(homedir(), root));
	}

	if (!path.isAbsolute(root)) {
		throw new TypeError('Read roots must be absolute or start with ~/.');
	}

	return canonicalHostPath(root);
}

export async function resolvePathGrants(
	workspace: string,
	grants: PathGrants | undefined,
	getExclusions: () => Promise<readonly string[]> = resolveCredentialExclusions
): Promise<readonly ResolvedPath[]> {
	if (grants === undefined) {
		return [];
	}

	const checkout = await canonicalHostPath(workspace);
	let excluded: Promise<readonly string[]> | undefined;
	const resolved: ResolvedPath[] = [];

	for (const kind of ['read', 'write'] as const) {
		const inputs = grants[kind] ?? [];
		const paths = new Map<string, ResolvedPath>();

		for (const input of inputs) {
			const absolute = hostPath(workspace, input);

			try {
				const candidate = await canonicalHostPath(absolute);
				const location = classifyHostPath(candidate, checkout);
				let isCredential = paths.get(candidate)?.isCredential === true;

				if (!isCredential && location !== 'workspace') {
					excluded ??= getExclusions();

					const roots = await excluded;

					isCredential =
						isWithinHostRoots(absolute, roots) ||
						isWithinHostRoots(candidate, roots);
				}

				paths.set(candidate, {
					kind,
					path: candidate,
					location,
					...(isCredential && { isCredential: true })
				});
			} catch (error) {
				throw new UnsupportedSandboxPolicyError(
					{
						operation: 'acquire',
						detail: {
							kind: 'path',
							access: kind,
							path: absolute,
							reason: 'unreachable'
						}
					},
					{ cause: error }
				);
			}
		}

		const ordered = paths
			.values()
			.toArray()
			.toSorted(
				(left, right) =>
					Number(left.path > right.path) - Number(left.path < right.path)
			);

		resolved.push(...ordered);
	}

	return resolved;
}

export function requestedPathGrants(
	paths: readonly ResolvedPath[]
): PathGrants | undefined {
	const read = paths
		.filter((entry) => entry.kind === 'read')
		.map((entry) => entry.path);
	const write = paths
		.filter((entry) => entry.kind === 'write')
		.map((entry) => entry.path);

	return paths.length === 0
		? undefined
		: {
				...(read.length > 0 && { read }),
				...(write.length > 0 && { write })
			};
}
