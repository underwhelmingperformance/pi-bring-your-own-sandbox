import path from 'node:path';

import type {
	DirectoryEntry,
	FileStat,
	FindResult,
	GrepMatch,
	GrepResult,
	SandboxWorkspace
} from './contracts.js';
import { isSafeText, isTargetPath } from './process-input.js';
import { isRecord } from './validation.js';

function isFileSize(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export function isFileStat(value: unknown): value is FileStat {
	return (
		isRecord(value) &&
		['file', 'directory', 'other'].some((kind) => kind === value.kind) &&
		isFileSize(value.size)
	);
}

export function isDirectoryEntries(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor']
): value is readonly DirectoryEntry[] {
	if (!Array.isArray(value)) {
		return false;
	}
	const entries: readonly unknown[] = value;
	const ids = new Set<string>();
	return entries.values().every((entry) => {
		if (
			!isRecord(entry) ||
			!isTargetPath(entry.name) ||
			entry.name === '.' ||
			entry.name === '..' ||
			path[flavor].basename(entry.name) !== entry.name ||
			['file', 'directory', 'symlink', 'other'].every(
				(kind) => kind !== entry.kind
			) ||
			ids.has(entry.name)
		) {
			return false;
		}
		ids.add(entry.name);
		return true;
	});
}

function isRelativePath(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor']
): value is string {
	if (!isTargetPath(value) || path[flavor].parse(value).root !== '') {
		return false;
	}
	const segments = flavor === 'posix' ? value.split('/') : value.split(/[/\\]/);
	return segments.every((segment) => !['', '.', '..'].includes(segment));
}

export function isFindResult(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor'],
	limit: number
): value is FindResult {
	if (
		!isRecord(value) ||
		typeof value.truncated !== 'boolean' ||
		!Array.isArray(value.paths) ||
		value.paths.length > limit ||
		(value.truncated && value.paths.length !== limit)
	) {
		return false;
	}
	const paths: readonly unknown[] = value.paths;
	const ids = new Set<string>();
	return paths.values().every((entry) => {
		if (typeof entry !== 'string') {
			return false;
		}
		const hasMarker =
			entry.endsWith('/') || (flavor === 'win32' && entry.endsWith('\\'));
		const target = hasMarker ? entry.slice(0, -1) : entry;
		const id = flavor === 'win32' ? target.replaceAll('\\', '/') : target;
		if (!isRelativePath(target, flavor) || ids.has(id)) {
			return false;
		}
		ids.add(id);
		return true;
	});
}

function isLines(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) {
		return false;
	}
	const entries: readonly unknown[] = value;
	return entries
		.values()
		.every((entry) => isSafeText(entry) && !entry.includes('\n'));
}

function isMatch(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor']
): value is GrepMatch {
	return (
		isRecord(value) &&
		isRelativePath(value.path, flavor) &&
		typeof value.line === 'number' &&
		Number.isSafeInteger(value.line) &&
		value.line > 0 &&
		isSafeText(value.text) &&
		!value.text.includes('\n') &&
		isLines(value.before) &&
		isLines(value.after)
	);
}

export function isGrepResult(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor'],
	limit: number,
	context: number
): value is GrepResult {
	if (
		!isRecord(value) ||
		typeof value.truncated !== 'boolean' ||
		!Array.isArray(value.matches) ||
		value.matches.length > limit ||
		(value.truncated && value.matches.length !== limit)
	) {
		return false;
	}
	const matches: readonly unknown[] = value.matches;
	const ids = new Set<string>();
	return matches.values().every((entry) => {
		if (
			!isMatch(entry, flavor) ||
			entry.before.length > context ||
			entry.before.length >= entry.line ||
			entry.after.length > context
		) {
			return false;
		}
		const filename =
			flavor === 'win32' ? entry.path.replaceAll('\\', '/') : entry.path;
		const id = `${filename}\0${String(entry.line)}`;
		if (ids.has(id)) {
			return false;
		}
		ids.add(id);
		return true;
	});
}
