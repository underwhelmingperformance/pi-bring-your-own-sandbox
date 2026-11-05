import type { ProcessOptions, ProcessRequest } from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import {
	processOptionsSchema,
	processRequestSchema
} from './request-schemas.js';
import { checker, safeTextSchema, targetPathSchema } from './schemas.js';

export { MAX_CAPTURE_BYTES } from './request-schemas.js';
export const DEFAULT_EXEC_TIMEOUT_MS = 120_000;

export const isSafeText = checker(safeTextSchema);
export const isTargetPath = checker(targetPathSchema);

const isRequest = checker(processRequestSchema);
const isOptions = checker(processOptionsSchema);

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

export function snapshotProcessOptions(input: unknown): ProcessOptions {
	const value = input === undefined ? {} : input;

	if (!isOptions(value)) {
		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}

	return Object.freeze({ ...value });
}
