import type {
	FindRequest,
	GrepRequest,
	SandboxOperation,
	SandboxOperationOptions,
	SandboxWriteOptions
} from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { isTargetPath } from './process-input.js';
import {
	accessModeSchema,
	findRequestSchema,
	grepRequestSchema,
	operationOptionsSchema,
	writeOptionsSchema
} from './request-schemas.js';
import { checker } from './schemas.js';

const isOperationOptions = checker(operationOptionsSchema);
const isWriteOptions = checker(writeOptionsSchema);
const isFindRequest = checker(findRequestSchema);
const isGrepRequest = checker(grepRequestSchema);
const isAccessMode = checker(accessModeSchema);

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

	if (!isOperationOptions(value)) {
		throw new InvalidSandboxRequestError({ operation });
	}

	return Object.freeze({ ...value });
}

export function writeOptions(input: unknown): SandboxWriteOptions {
	const value = input === undefined ? {} : input;

	if (!isWriteOptions(value)) {
		throw new InvalidSandboxRequestError({ operation: 'writeFile' });
	}

	const { createParents, ...remaining } = value;

	return Object.freeze({
		...operationOptions(remaining, 'writeFile'),
		...(createParents !== undefined && { createParents })
	});
}

export function findRequest(value: unknown): FindRequest {
	if (!isFindRequest(value)) {
		throw new InvalidSandboxRequestError({ operation: 'find' });
	}

	return Object.freeze({
		pattern: value.pattern,
		...(value.path !== undefined && { path: value.path }),
		limit: value.limit ?? findRequestSchema.properties.limit.default
	});
}

export function grepRequest(value: unknown): GrepRequest {
	if (!isGrepRequest(value)) {
		throw new InvalidSandboxRequestError({ operation: 'grep' });
	}

	return Object.freeze({
		pattern: value.pattern,
		...(value.path !== undefined && { path: value.path }),
		...(value.glob !== undefined && { glob: value.glob }),
		limit: value.limit ?? grepRequestSchema.properties.limit.default,
		context: value.context ?? grepRequestSchema.properties.context.default,
		literal: value.literal ?? grepRequestSchema.properties.literal.default,
		ignoreCase:
			value.ignoreCase ?? grepRequestSchema.properties.ignoreCase.default
	});
}

export function accessMode(value: unknown): 'read' | 'write' {
	if (!isAccessMode(value)) {
		throw new InvalidSandboxRequestError({ operation: 'access' });
	}

	return value;
}
