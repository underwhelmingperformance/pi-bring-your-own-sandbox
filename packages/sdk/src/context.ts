import { realpath } from 'node:fs/promises';
import path from 'node:path';

import type { SandboxContext, SandboxOperation } from './contracts.js';
import {
	SandboxInitialisationError,
	StaleSandboxHandleError
} from './errors.js';
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

export class SandboxSession implements SessionIdentity {
	static async capture(context: SandboxContext): Promise<SandboxSession> {
		const original = inspectContext(context, 'acquire');
		let workspace: string;

		try {
			if (!path.isAbsolute(original.workspace)) {
				throw new TypeError('Pi must supply an absolute workspace path.');
			}

			workspace = await realpath(original.workspace);
		} catch (error) {
			throw new SandboxInitialisationError(
				{ operation: 'acquire' },
				{ cause: error }
			);
		}

		const session = new SandboxSession(context, original, workspace);

		session.check(context, 'acquire');

		return session;
	}

	readonly #source: SandboxContext;
	readonly #original: SessionIdentity;
	readonly context: SandboxContext;
	readonly sessionId: string;
	readonly workspace: string;

	constructor(
		source: SandboxContext,
		original = inspectContext(source, 'acquire'),
		workspace = original.workspace
	) {
		this.#source = source;
		this.#original = original;
		this.sessionId = original.sessionId;
		this.workspace = workspace;
		this.context = Object.freeze({
			cwd: workspace,
			sessionManager: source.sessionManager,
			...(source.isProjectTrusted !== undefined && {
				isProjectTrusted: source.isProjectTrusted
			})
		});
	}

	check(context: SandboxContext, operation: SandboxOperation): void {
		const actual = inspectContext(context, operation);
		const original = inspectContext(this.#source, operation);

		if (
			actual.sessionId !== this.sessionId ||
			(actual.workspace !== this.workspace &&
				actual.workspace !== this.#original.workspace) ||
			original.sessionId !== this.sessionId ||
			original.workspace !== this.#original.workspace
		) {
			throw new StaleSandboxHandleError({ operation });
		}
	}
}
