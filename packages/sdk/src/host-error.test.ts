import { expect, it } from 'vitest';

import { hostError } from './host-error.js';

it.each([
	['ENOENT', 'SandboxPathNotFoundError'],
	['ENOTDIR', 'SandboxPathNotFoundError'],
	['EACCES', 'SandboxPermissionDeniedError'],
	['EPERM', 'SandboxPermissionDeniedError'],
	['EROFS', 'SandboxPermissionDeniedError'],
	['EIO', 'SandboxOperationError']
])('maps %s to %s and preserves the cause', (code, name) => {
	const cause = Object.assign(new Error('Fixture filesystem failure.'), {
		code
	});
	const error = hostError(cause, 'writeFile');

	expect({
		name: error.name,
		operation: error.operation,
		providerId: error.providerId,
		cause: error.cause
	}).toStrictEqual({
		name,
		operation: 'writeFile',
		providerId: 'passthrough',
		cause
	});
});
