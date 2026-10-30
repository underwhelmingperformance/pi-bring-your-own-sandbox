import type {
	FindRequest,
	GrepRequest,
	SandboxOperation,
	SandboxOperationOptions,
	SandboxWriteOptions
} from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { isSafeText, isSignal, isTargetPath } from './process-input.js';
import { isRecord } from './validation.js';

export function requirePath(
	path: unknown,
	operation: SandboxOperation
): string {
	if (!isTargetPath(path)) {
		throw new InvalidSandboxRequestError({ operation });
	}
	return path;
}

export function operationOptions(
	input: unknown,
	operation: SandboxOperation
): SandboxOperationOptions {
	const value = input === undefined ? {} : input;
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !['signal', 'timeoutMs'].includes(key)) ||
		(value.signal !== undefined && !isSignal(value.signal)) ||
		(value.timeoutMs !== undefined &&
			(typeof value.timeoutMs !== 'number' ||
				!Number.isFinite(value.timeoutMs) ||
				value.timeoutMs <= 0))
	) {
		throw new InvalidSandboxRequestError({ operation });
	}
	return Object.freeze({ ...value });
}

export function writeOptions(input: unknown): SandboxWriteOptions {
	const value = input === undefined ? {} : input;
	if (
		!isRecord(value) ||
		(value.createParents !== undefined &&
			typeof value.createParents !== 'boolean')
	) {
		throw new InvalidSandboxRequestError({ operation: 'writeFile' });
	}
	const { createParents, ...remaining } = value;
	return Object.freeze({
		...operationOptions(remaining, 'writeFile'),
		...(createParents !== undefined && { createParents })
	});
}

function isLimit(value: unknown): value is number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
}

export function findRequest(value: unknown): FindRequest {
	if (
		!isRecord(value) ||
		!isSafeText(value.pattern) ||
		(value.path !== undefined && !isTargetPath(value.path)) ||
		(value.limit !== undefined && !isLimit(value.limit)) ||
		Object.keys(value).some(
			(key) => !['pattern', 'path', 'limit'].includes(key)
		)
	) {
		throw new InvalidSandboxRequestError({ operation: 'find' });
	}
	return Object.freeze({
		pattern: value.pattern,
		...(value.path !== undefined && { path: value.path }),
		limit: value.limit ?? 1000
	});
}

export function grepRequest(value: unknown): GrepRequest {
	if (
		!isRecord(value) ||
		!isSafeText(value.pattern) ||
		(value.path !== undefined && !isTargetPath(value.path)) ||
		(value.limit !== undefined && !isLimit(value.limit)) ||
		(value.context !== undefined &&
			(typeof value.context !== 'number' ||
				!Number.isSafeInteger(value.context) ||
				value.context < 0)) ||
		(value.glob !== undefined && !isSafeText(value.glob)) ||
		(value.literal !== undefined && typeof value.literal !== 'boolean') ||
		(value.ignoreCase !== undefined && typeof value.ignoreCase !== 'boolean') ||
		Object.keys(value).some(
			(key) =>
				![
					'pattern',
					'path',
					'limit',
					'context',
					'glob',
					'literal',
					'ignoreCase'
				].includes(key)
		)
	) {
		throw new InvalidSandboxRequestError({ operation: 'grep' });
	}
	return Object.freeze({
		pattern: value.pattern,
		...(value.path !== undefined && { path: value.path }),
		...(value.glob !== undefined && { glob: value.glob }),
		limit: value.limit ?? 100,
		context: value.context ?? 0,
		literal: value.literal ?? false,
		ignoreCase: value.ignoreCase ?? false
	});
}

export function accessMode(value: unknown): 'read' | 'write' {
	if (value !== 'read' && value !== 'write') {
		throw new InvalidSandboxRequestError({ operation: 'access' });
	}
	return value;
}
