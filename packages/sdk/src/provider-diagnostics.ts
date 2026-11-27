import type { SandboxDiagnosticRecord } from './contracts.js';

export type DiagnosticIdentity = Pick<
	SandboxDiagnosticRecord,
	'operationId' | 'operation' | 'providerId' | 'backendId'
>;
export type DiagnosticReporter = (
	identity: DiagnosticIdentity,
	message: unknown
) => void;

export interface DiagnosticStore {
	readonly record: DiagnosticReporter;
	readonly snapshot: () => {
		readonly entries: readonly SandboxDiagnosticRecord[];
		readonly dropped: number;
	};
}

export class ProviderDiagnostics implements DiagnosticStore {
	readonly #entries: SandboxDiagnosticRecord[] = [];
	#dropped = 0;

	record(identity: DiagnosticIdentity, message: unknown): void {
		if (
			typeof message !== 'string' ||
			message.length === 0 ||
			message.length > 2048 ||
			this.#entries.length >= 64
		) {
			this.#dropped = Math.min(Number.MAX_SAFE_INTEGER, this.#dropped + 1);

			return;
		}

		this.#entries.push(
			Object.freeze({
				operationId: identity.operationId,
				operation: identity.operation,
				...(identity.providerId !== undefined && {
					providerId: identity.providerId
				}),
				...(identity.backendId !== undefined && {
					backendId: identity.backendId
				}),
				message
			})
		);
	}

	snapshot() {
		return Object.freeze({
			entries: Object.freeze([...this.#entries]),
			dropped: this.#dropped
		});
	}
}
