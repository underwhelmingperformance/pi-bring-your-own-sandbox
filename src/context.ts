import type { SandboxContext, SandboxOperation } from './contracts.js';
import { StaleSandboxHandleError } from './errors.js';
import { isNonEmptyString } from './validation.js';

export interface SessionIdentity {
	readonly sessionId: string;
	readonly workspace: string;
}

export function inspectContext(
	context: SandboxContext,
	operation: SandboxOperation
): SessionIdentity {
	try {
		const workspace = context.cwd;
		const sessionId = context.sessionManager.getSessionId();

		if (!isNonEmptyString(workspace) || !isNonEmptyString(sessionId)) {
			throw new StaleSandboxHandleError({ operation });
		}

		return Object.freeze({ workspace, sessionId });
	} catch (error) {
		throw new StaleSandboxHandleError({ operation }, { cause: error });
	}
}
