import { realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { resolveCredentialLocations } from './credential-locations.js';
import { UnsupportedSandboxPolicyError } from './errors.js';
import { hostSystemRoots } from './host-system-roots.js';
import { hostToolchainRoots } from './host-toolchain-roots.js';
import type { PathGrants } from './policy-model.js';
import type { ResolvedPath } from './profile-negotiation.js';

const darwinDataVolume = '/System/Volumes/Data';

function comparisonPath(candidate: string, host = platform()): string {
	// realpath preserves the Data volume spelling across APFS firmlinks.
	return host === 'darwin' && candidate.startsWith(darwinDataVolume + '/')
		? candidate.slice(darwinDataVolume.length)
		: candidate;
}

function isWithin(root: string, candidate: string): boolean {
	const relative = path.relative(root, candidate);

	return (
		relative !== '..' &&
		!relative.startsWith(`..${path.sep}`) &&
		!path.isAbsolute(relative)
	);
}

async function canonicalPath(candidate: string): Promise<string> {
	try {
		return await realpath(candidate);
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!('code' in error) ||
			error.code !== 'ENOENT'
		) {
			throw error;
		}

		const parent = path.dirname(candidate);

		return parent === candidate
			? candidate
			: path.join(await canonicalPath(parent), path.basename(candidate));
	}
}

function isHomeRelative(input: string): boolean {
	return (
		input === '~' ||
		input.startsWith('~/') ||
		(path.sep === '\\' && input.startsWith('~\\'))
	);
}

function hostPath(workspace: string, input: string): string {
	return isHomeRelative(input)
		? path.resolve(homedir(), input.slice(2))
		: path.resolve(workspace, input);
}

export async function resolveHostUserDataRoots(
	settings: readonly string[] = []
): Promise<readonly string[]> {
	const host = platform();
	const builtIn =
		host === 'darwin' || host === 'linux' ? hostToolchainRoots[host] : [];

	const roots = await Promise.all(
		[...builtIn, ...settings].map(async (root) => {
			if (isHomeRelative(root)) {
				return canonicalPath(path.resolve(homedir(), root.slice(2)));
			}

			if (!path.isAbsolute(root)) {
				throw new TypeError('Read roots must be absolute or start with ~/.');
			}

			return canonicalPath(path.normalize(root));
		})
	);

	return Object.freeze([...new Set(roots)]);
}

export function isWithinHostUserDataRoots(
	candidate: string,
	roots: readonly string[]
): boolean {
	const compared = comparisonPath(candidate);

	return roots.some((root) => isWithin(comparisonPath(root), compared));
}

export async function resolvePathGrants(
	workspace: string,
	grants: PathGrants | undefined
): Promise<readonly ResolvedPath[]> {
	if (grants === undefined) {
		return [];
	}

	const host = platform();
	const systemRoots =
		host === 'darwin' || host === 'linux' ? hostSystemRoots[host] : [];
	const root = comparisonPath(await canonicalPath(workspace), host);
	const excluded = resolveCredentialLocations();
	const excludedResolved = await Promise.all(
		excluded.map(async (location) => {
			try {
				return comparisonPath(await canonicalPath(location), host);
			} catch {
				return comparisonPath(location, host);
			}
		})
	);
	const excludedLexical = excluded.map((location) =>
		comparisonPath(location, host)
	);
	const resolved: ResolvedPath[] = [];

	for (const kind of ['read', 'write'] as const) {
		const inputs = grants[kind] ?? [];
		const paths = new Map<string, boolean>();

		for (const input of inputs) {
			const absolute = hostPath(workspace, input);

			try {
				const candidate = await canonicalPath(absolute);
				const lexical = comparisonPath(absolute, host);
				const canonical = comparisonPath(candidate, host);

				paths.set(
					candidate,
					paths.get(candidate) === true ||
						excludedLexical.some((location) => isWithin(location, lexical)) ||
						excludedResolved.some((location) => isWithin(location, canonical))
				);
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
			.keys()
			.toArray()
			.toSorted((left, right) => Number(left > right) - Number(left < right));

		for (const candidate of ordered) {
			const isCredential = paths.get(candidate) === true;
			const file = comparisonPath(candidate, host);
			const location = isWithin(root, file)
				? 'workspace'
				: systemRoots.some((directory) => isWithin(directory, file))
					? 'host-system-files'
					: 'host-user-data';

			resolved.push({
				kind,
				path: candidate,
				location,
				...(isCredential && location !== 'workspace' && { isCredential: true })
			});
		}
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
