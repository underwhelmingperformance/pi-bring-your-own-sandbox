import type { SandboxErrorContext, SandboxOperation } from './contracts.js';
import {
	isSandboxError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError
} from './errors.js';
import { isRecord } from './validation.js';

/**
Maps a Node filesystem error or a target's errno code to an SDK error.
An SDK error returned by a lower layer keeps its original identity.
*/
export function mapSandboxErrno(cause: unknown, context: SandboxErrorContext) {
	if (isSandboxError(cause)) {
		return cause;
	}

	const code = isRecord(cause) ? cause['code'] : cause;
	const options = typeof cause === 'string' ? undefined : { cause };

	switch (code) {
		case 'ENOENT':
		case 'ENOTDIR': {
			return new SandboxPathNotFoundError(context, options);
		}

		case 'EACCES':
		case 'EPERM':
		case 'EROFS': {
			return new SandboxPermissionDeniedError(context, options);
		}

		default: {
			return new SandboxOperationError(context, options);
		}
	}
}

export function hostError(cause: unknown, operation: SandboxOperation) {
	return mapSandboxErrno(cause, { operation, providerId: 'passthrough' });
}
