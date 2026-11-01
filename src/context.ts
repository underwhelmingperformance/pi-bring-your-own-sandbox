import type { SandboxContext, SandboxOperation } from './contracts.js';
import { StaleSandboxHandleError } from './errors.js';
import { isNonEmptyString } from './validation.js';

export interface SessionIdentity {
	readonly sessionId: string;
	readonly workspace: string;
	readonly isProjectTrusted: boolean;
}

export function inspectContext(
	context: SandboxContext,
	operation: SandboxOperation
): SessionIdentity {
	try {
		const workspace = context.cwd;
		const sessionId = context.sessionManager.getSessionId();
		const isProjectTrusted = context.isProjectTrusted();

		if (
			typeof isProjectTrusted !== 'boolean' ||
			!isNonEmptyString(workspace) ||
			!isNonEmptyString(sessionId)
		) {
			throw new StaleSandboxHandleError({ operation });
		}

		return Object.freeze({ workspace, sessionId, isProjectTrusted });
	} catch (error) {
		throw new StaleSandboxHandleError({ operation }, { cause: error });
	}
}
