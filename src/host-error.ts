import type { SandboxOperation } from './contracts.js';
import {
	isSandboxError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError
} from './errors.js';
import { isRecord } from './validation.js';

export function hostError(cause: unknown, operation: SandboxOperation) {
	if (isSandboxError(cause)) {
		return cause;
	}

	const context = { operation, providerId: 'passthrough' };

	if (
		isRecord(cause) &&
		(cause.code === 'ENOENT' || cause.code === 'ENOTDIR')
	) {
		return new SandboxPathNotFoundError(context, { cause });
	}

	if (isRecord(cause) && (cause.code === 'EACCES' || cause.code === 'EPERM')) {
		return new SandboxPermissionDeniedError(context, { cause });
	}

	return new SandboxOperationError(context, { cause });
}
