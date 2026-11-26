import type { SandboxBackend, SandboxCopySource } from './contracts.js';
import { StaleSandboxHandleError } from './errors.js';

/**
Returns the source backend for a copy, or undefined for a host copy.
The broker checks session and generation ownership before calling the provider.
The predicate checks provider-specific ownership, configuration and liveness.
*/
export function resolveSandboxCopySource<Backend extends SandboxBackend>(
	source: SandboxCopySource,
	isValidSource: (backend: SandboxBackend) => backend is Backend
): Backend | undefined {
	if (source.kind === 'host') {
		return undefined;
	}

	if (!isValidSource(source.backend)) {
		throw new StaleSandboxHandleError({ operation: 'open' });
	}

	return source.backend;
}
