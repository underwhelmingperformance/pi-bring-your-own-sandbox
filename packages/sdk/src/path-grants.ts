import { realpath } from 'node:fs/promises';
import { homedir, platform } from 'node:os';
import path from 'node:path';

import { credentialLocations } from './credential-locations.js';
import { UnsupportedSandboxPolicyError } from './errors.js';
import { hostSystemRoots } from './host-system-roots.js';
import type { PathGrants } from './policy-model.js';
import type { ResolvedPath } from './profile-negotiation.js';

const darwinDataVolume = '/System/Volumes/Data';

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

function hostPath(workspace: string, input: string): string {
	if (input === '~') {
		return homedir();
	}

	return input.startsWith('~/') ||
		(path.sep === '\\' && input.startsWith('~\\'))
		? path.resolve(homedir(), input.slice(2))
		: path.resolve(workspace, input);
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
	// realpath preserves the Data volume spelling across APFS firmlinks.
	const comparisonPath = (candidate: string) =>
		host === 'darwin' && candidate.startsWith(darwinDataVolume + '/')
			? candidate.slice(darwinDataVolume.length)
			: candidate;
	const root = comparisonPath(await canonicalPath(workspace));
	const home = homedir();
	const excluded = credentialLocations.map((location) =>
		path.join(home, location.slice(2))
	);
	const excludedResolved = await Promise.all(
		excluded.map(async (location) => {
			try {
				return comparisonPath(await canonicalPath(location));
			} catch {
				return comparisonPath(location);
			}
		})
	);
	const excludedLexical = excluded.map((location) => comparisonPath(location));
	const resolved: ResolvedPath[] = [];

	for (const kind of ['read', 'write'] as const) {
		const inputs = grants[kind] ?? [];
		const paths = new Map<string, boolean>();

		for (const input of inputs) {
			const absolute = hostPath(workspace, input);

			try {
				const candidate = await canonicalPath(absolute);
				const lexical = comparisonPath(absolute);
				const canonical = comparisonPath(candidate);

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
			const file = comparisonPath(candidate);
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
