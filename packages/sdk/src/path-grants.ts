import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { credentialLocations } from './credential-locations.js';
import { UnsupportedSandboxPolicyError } from './errors.js';
import type { PathGrants } from './policy-model.js';
import type { ResolvedPath } from './profile-negotiation.js';

const systemRoots = [
	'/bin',
	'/sbin',
	'/usr/bin',
	'/usr/sbin',
	'/lib',
	'/lib64',
	'/usr/lib',
	'/usr/libexec',
	'/usr/share',
	'/System',
	'/Library/Apple/System',
	'/etc',
	'/private/etc'
];

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

	const root = await canonicalPath(workspace);
	const home = homedir();
	const excluded = credentialLocations.map((location) =>
		path.join(home, location.slice(2))
	);
	const excludedResolved = await Promise.all(
		excluded.map(async (location) => {
			try {
				return await canonicalPath(location);
			} catch {
				return location;
			}
		})
	);
	const resolved: ResolvedPath[] = [];

	for (const kind of ['read', 'write'] as const) {
		const inputs = grants[kind] ?? [];
		const paths = new Map<string, boolean>();

		for (const input of inputs) {
			const absolute = hostPath(workspace, input);

			try {
				const candidate = await canonicalPath(absolute);

				paths.set(
					candidate,
					paths.get(candidate) === true ||
						excluded.some((location) => isWithin(location, absolute)) ||
						excludedResolved.some((location) => isWithin(location, candidate))
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
			const location = isWithin(root, candidate)
				? 'workspace'
				: !isCredential &&
					  systemRoots.some((directory) => isWithin(directory, candidate))
					? 'host-system-files'
					: 'host-user-data';

			resolved.push({
				kind,
				path: candidate,
				location,
				...(isCredential &&
					location === 'host-user-data' && { isCredential: true })
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
