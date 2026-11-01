import { Value } from 'typebox/value';

import type {
	DirectoryEntry,
	FindResult,
	GrepResult,
	SandboxWorkspace
} from './contracts.js';
import {
	directoryEntriesSchema,
	fileStatSchema,
	findResultSchema,
	grepResultSchema
} from './result-schemas.js';
import { checker } from './schemas.js';

export const isFileStat = checker(fileStatSchema);

const directoryValidators = {
	posix: checker(directoryEntriesSchema('posix')),
	win32: checker(directoryEntriesSchema('win32'))
};

export function isDirectoryEntries(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor']
): value is readonly DirectoryEntry[] {
	return directoryValidators[flavor](value);
}

export function isFindResult(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor'],
	limit: number
): value is FindResult {
	return Value.Check(findResultSchema(flavor, limit), value);
}

export function isGrepResult(
	value: unknown,
	flavor: SandboxWorkspace['pathFlavor'],
	limit: number,
	context: number
): value is GrepResult {
	return Value.Check(grepResultSchema(flavor, limit, context), value);
}
