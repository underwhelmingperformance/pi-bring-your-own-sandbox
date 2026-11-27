import type { SandboxHost, ShellReviewClient } from './contracts.js';
import { bindFactory } from './default-broker.js';
import { SandboxInitialisationError } from './errors.js';
import { isPiBound } from './protocol-address.js';
import { findShellReviewSource, hasShellReviewRoute } from './review-route.js';

/**
Register a permission reviewer during its Pi extension factory.
*/
export function createShellReviewClient(
	pi: SandboxHost,
	extensionSource: string
): ShellReviewClient {
	if (isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	bindFactory(pi, extensionSource);

	return Object.freeze<ShellReviewClient>({
		hasShellReviewRoute: () => hasShellReviewRoute(pi),
		findShellReviewSource: (context, call) =>
			findShellReviewSource(pi, context, call)
	});
}
