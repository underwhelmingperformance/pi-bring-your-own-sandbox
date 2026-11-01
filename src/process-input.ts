import type {
	ProcessEnvironment,
	ProcessOptions,
	ProcessRequest
} from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { isRecord, isShell } from './validation.js';

export const MAX_CAPTURE_BYTES = 1_048_576;
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export function isSafeText(value: unknown): value is string {
	return typeof value === 'string' && !value.includes('\0');
}

export function isTargetPath(value: unknown): value is string {
	return isSafeText(value) && value.length > 0;
}

export function isSignal(value: unknown): value is AbortSignal {
	return (
		isRecord(value) &&
		typeof value.aborted === 'boolean' &&
		typeof value.addEventListener === 'function' &&
		typeof value.removeEventListener === 'function' &&
		typeof value.dispatchEvent === 'function' &&
		typeof value.throwIfAborted === 'function' &&
		'reason' in value
	);
}

function isEnvironment(value: unknown): value is ProcessEnvironment {
	return (
		isRecord(value) &&
		Object.entries(value).every(
			([key, entry]) =>
				isTargetPath(key) &&
				!key.includes('=') &&
				(entry === null || isSafeText(entry))
		)
	);
}

function isArguments(value: unknown): value is readonly string[] {
	if (!Array.isArray(value)) {
		return false;
	}

	const entries: readonly unknown[] = value;

	return entries.values().every(isSafeText);
}

function isRequest(value: unknown): value is ProcessRequest {
	if (
		!isRecord(value) ||
		(value.cwd !== undefined && !isTargetPath(value.cwd)) ||
		(value.env !== undefined && !isEnvironment(value.env))
	) {
		return false;
	}

	if (value.kind === 'argv') {
		return (
			Object.keys(value).every((key) =>
				['kind', 'executable', 'args', 'cwd', 'env'].includes(key)
			) &&
			isTargetPath(value.executable) &&
			isArguments(value.args)
		);
	}

	return (
		value.kind === 'shell' &&
		isSafeText(value.command) &&
		isShell(value.dialect) &&
		Object.keys(value).every((key) =>
			['kind', 'command', 'dialect', 'cwd', 'env'].includes(key)
		)
	);
}

export function snapshotProcessRequest(value: unknown): ProcessRequest {
	if (!isRequest(value)) {
		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}

	const location = {
		...(value.cwd !== undefined && { cwd: value.cwd }),
		...(value.env !== undefined && { env: Object.freeze({ ...value.env }) })
	};

	return value.kind === 'argv'
		? Object.freeze({
				...location,
				kind: 'argv',
				executable: value.executable,
				args: Object.freeze([...value.args])
			})
		: Object.freeze({
				...location,
				kind: 'shell',
				command: value.command,
				dialect: value.dialect
			});
}

function isOptions(value: unknown): value is ProcessOptions {
	return (
		isRecord(value) &&
		Object.keys(value).every((key) =>
			['signal', 'timeoutMs', 'maxCaptureBytes', 'onOutput'].includes(key)
		) &&
		(value.signal === undefined || isSignal(value.signal)) &&
		(value.timeoutMs === undefined ||
			(typeof value.timeoutMs === 'number' &&
				Number.isFinite(value.timeoutMs) &&
				value.timeoutMs > 0)) &&
		(value.maxCaptureBytes === undefined ||
			(typeof value.maxCaptureBytes === 'number' &&
				Number.isSafeInteger(value.maxCaptureBytes) &&
				value.maxCaptureBytes >= 0 &&
				value.maxCaptureBytes <= MAX_CAPTURE_BYTES)) &&
		(value.onOutput === undefined || typeof value.onOutput === 'function')
	);
}

export function snapshotProcessOptions(input: unknown): ProcessOptions {
	const value = input === undefined ? {} : input;

	if (!isOptions(value)) {
		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}

	return Object.freeze({ ...value });
}
