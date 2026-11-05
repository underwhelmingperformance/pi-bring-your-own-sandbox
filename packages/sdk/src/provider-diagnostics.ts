import { Type } from 'typebox';

import type { SandboxDiagnosticRecord } from './contracts.js';
import { checker } from './schemas.js';

export type DiagnosticIdentity = Pick<
	SandboxDiagnosticRecord,
	'operationId' | 'operation' | 'providerId' | 'backendId'
>;
export type DiagnosticReporter = (
	identity: DiagnosticIdentity,
	diagnostic: unknown
) => void;

export interface DiagnosticStore {
	readonly record: DiagnosticReporter;
	readonly snapshot: () => {
		readonly entries: readonly SandboxDiagnosticRecord[];
		readonly dropped: number;
	};
}

const isDiagnostic = checker(
	Type.Object({
		level: Type.Literal('warning'),
		message: Type.String({ minLength: 1, maxLength: 2048 })
	})
);

function snapshotDiagnostic(input: unknown) {
	try {
		if (
			typeof input !== 'object' ||
			input === null ||
			Array.isArray(input) ||
			!('level' in input) ||
			!('message' in input)
		) {
			return;
		}

		const value = { level: input.level, message: input.message };

		return isDiagnostic(value) ? value : undefined;
	} catch {
		return;
	}
}

export class ProviderDiagnostics implements DiagnosticStore {
	readonly #entries: SandboxDiagnosticRecord[] = [];
	#dropped = 0;

	record(identity: DiagnosticIdentity, input: unknown): void {
		const value =
			this.#entries.length < 64 ? snapshotDiagnostic(input) : undefined;

		if (value === undefined) {
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
				level: value.level,
				message: value.message
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
