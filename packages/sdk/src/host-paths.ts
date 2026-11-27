import { lstat, readlink, realpath } from 'node:fs/promises';
import { platform } from 'node:os';
import path from 'node:path';

import { hostSystemRoots } from './host-system-roots.js';

export type HostPathLocation =
	'workspace' | 'host-user-data' | 'host-system-files';

const darwinDataVolume = '/System/Volumes/Data';

function isMissing(error: unknown): boolean {
	return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

async function isSymbolicLink(filename: string): Promise<boolean> {
	try {
		const metadata = await lstat(filename);

		return metadata.isSymbolicLink();
	} catch (error) {
		if (isMissing(error)) {
			return false;
		}

		throw error;
	}
}

/**
Resolve links in an absolute host path, including links to missing targets.
The result includes unresolved components below the nearest existing directory.
*/
export async function canonicalHostPath(absolutePath: string): Promise<string> {
	if (!path.isAbsolute(absolutePath)) {
		throw new TypeError('Canonicalisation requires an absolute host path.');
	}

	try {
		return await realpath(absolutePath);
	} catch (error) {
		if (!isMissing(error)) {
			throw error;
		}
	}

	const root = path.parse(absolutePath).root;
	const pending = absolutePath.slice(root.length).split(path.sep).toReversed();
	let resolved = root;
	let links = 0;

	for (
		let component = pending.pop();
		component !== undefined;
		component = pending.pop()
	) {
		if (component === '' || component === '.') {
			continue;
		}

		if (component === '..') {
			resolved = path.dirname(resolved);
			continue;
		}

		const candidate = path.join(resolved, component);

		if (!(await isSymbolicLink(candidate))) {
			resolved = candidate;
			continue;
		}

		if (++links > 40) {
			throw new RangeError('Too many symbolic links in the host path.');
		}

		const target = await readlink(candidate);
		const targetRoot = path.parse(target).root;

		if (targetRoot !== '') {
			resolved = targetRoot;
		}

		pending.push(
			...target.slice(targetRoot.length).split(path.sep).toReversed()
		);
	}

	return resolved;
}

/**
Compare canonical host paths across known aliases. Keep the real path for I/O.
*/
export function hostPathComparisonKey(
	canonicalPath: string,
	host: NodeJS.Platform
): string {
	return host === 'darwin' && canonicalPath.startsWith(darwinDataVolume + '/')
		? canonicalPath.slice(darwinDataVolume.length)
		: canonicalPath;
}

/**
Compare canonical host paths with platform aliases applied. Providers enforce
filesystem confinement separately.
*/
export function isWithinHostRoots(
	canonicalPath: string,
	roots: readonly string[]
): boolean {
	const host = platform();
	const candidate = hostPathComparisonKey(canonicalPath, host);

	return roots.some((root) => {
		const relative = path.relative(
			hostPathComparisonKey(root, host),
			candidate
		);

		return (
			relative !== '..' &&
			!relative.startsWith(`..${path.sep}`) &&
			!path.isAbsolute(relative)
		);
	});
}

/**
Classify a canonical path against the checkout and the host's system roots.
*/
export function classifyHostPath(
	canonicalPath: string,
	canonicalCheckout: string
): HostPathLocation {
	if (isWithinHostRoots(canonicalPath, [canonicalCheckout])) {
		return 'workspace';
	}

	const host = platform();
	const systemRoots =
		host === 'darwin' || host === 'linux' ? hostSystemRoots[host] : [];

	return isWithinHostRoots(canonicalPath, systemRoots)
		? 'host-system-files'
		: 'host-user-data';
}
