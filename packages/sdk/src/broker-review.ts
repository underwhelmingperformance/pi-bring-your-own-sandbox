import { homedir } from 'node:os';

import { acquireOptions } from './acquire-options.js';
import type {
	ReviewedToolCall,
	SandboxContext,
	ShellDialect,
	ShellReviewSource
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError,
	StaleSandboxHandleError
} from './errors.js';
import type {
	DestinationDescription,
	EscalationDecision,
	EscalationEntry,
	EscalationRequest,
	SandboxLedgerEntry
} from './escalation-ledger.js';
import type { SandboxGeneration } from './generation.js';
import { passthroughProvider } from './passthrough-provider.js';
import { shellRequirements } from './profile-negotiation.js';
import type { CopySourceIdentity } from './protocol.js';
import type { ReviewRegistration } from './review-identities.js';
import { checkCopiedSandbox, rethrowCopyError } from './sandbox-copy.js';

type PermissionDecider = Extract<
	NonNullable<EscalationEntry['decider']>,
	{ kind: 'permission-extension' }
>;

type ReviewDecision =
	| { readonly choice: EscalationDecision; readonly decider: PermissionDecider }
	| { readonly choice: 'conflict' };

export interface BrokerReviewRegistration extends ReviewRegistration {
	readonly decision: () => ReviewDecision | undefined;
	readonly claimDecision: () => ReviewDecision | undefined;
}

export class ReviewState {
	#isClaimed = false;
	#decision: ReviewDecision | undefined;
	readonly #deadline: number | undefined;
	readonly signal: AbortSignal | undefined;

	constructor(deadline?: number, signal?: AbortSignal) {
		this.#deadline = deadline;
		this.signal = signal;
	}

	isCurrent(): boolean {
		return (
			this.signal?.aborted !== true &&
			(this.#deadline === undefined || performance.now() < this.#deadline)
		);
	}

	bind(registration: ReviewRegistration): BrokerReviewRegistration {
		return Object.freeze<BrokerReviewRegistration>({
			...registration,
			decision: () => this.#decision,
			claimDecision: () => {
				this.#isClaimed = true;

				return this.#decision;
			}
		});
	}

	record(choice: unknown, extension: string): void {
		if (
			!this.isCurrent() ||
			this.#isClaimed ||
			(choice !== 'allow' && choice !== 'deny')
		) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}

		if (this.#decision === undefined) {
			this.#decision = Object.freeze({
				choice,
				decider: Object.freeze({ kind: 'permission-extension', extension })
			});

			return;
		}

		if (this.#decision.choice === choice) {
			return;
		}

		this.#decision = Object.freeze({ choice: 'conflict' });

		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}
}

interface ReviewDestination {
	readonly destination: DestinationDescription;
	readonly source: CopySourceIdentity;
}

export interface RegisteredReview {
	readonly call: ReviewedToolCall;
	readonly command: string;
	readonly escalation?: EscalationRequest;
	readonly state: ReviewState;
	readonly target: ReviewDestination;
	readonly generation: SandboxGeneration;
}

export async function describeReviewDestination(
	generation: SandboxGeneration,
	context: SandboxContext,
	dialect: ShellDialect,
	escalation: EscalationRequest | undefined
): Promise<ReviewDestination> {
	const status = await generation.status();

	if (status.state === 'closed' || status.state === 'closing') {
		throw new StaleSandboxHandleError({ operation: 'acquire' });
	}

	const selection = status.selection;

	if (selection === undefined) {
		throw (
			status.failure ?? new SandboxInitialisationError({ operation: 'acquire' })
		);
	}

	const proposed = escalation?.destination;
	let policy = proposed?.policy;
	let backend: ReturnType<SandboxGeneration['readyBackend']>;

	if (policy === undefined) {
		const ordinary = await generation.negotiate(
			context,
			shellRequirements(dialect)
		);

		if (!ordinary.ok) {
			throw ordinary.error;
		}

		policy = ordinary.profile.policy;
		backend = generation.readyBackend(ordinary.profile);
	}

	const isHost = proposed?.kind === 'host' || selection.source === 'default';
	const providerId = isHost ? passthroughProvider.id : selection.providerId;
	const label = isHost
		? passthroughProvider.label
		: (status.providerLabel ?? providerId);
	const backendId = backend?.id;
	const workspace = backend?.workspace;
	const location =
		workspace ??
		(isHost
			? Object.freeze({
					root: context.cwd,
					home: homedir(),
					pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
					relationship: 'shared'
				} as const)
			: undefined);

	return Object.freeze({
		destination: Object.freeze({
			providerId,
			label,
			policy,
			...(location !== undefined && { workspace: location })
		}),
		source:
			backendId === undefined
				? { kind: 'host' as const }
				: {
						kind: 'sandbox' as const,
						providerId,
						backendId,
						generationId: status.generationId
					}
	});
}

export function resolvedReviewSource(
	context: SandboxContext,
	review: RegisteredReview,
	extension: string,
	isCurrent: () => boolean,
	append?: (entry: SandboxLedgerEntry) => void
): ShellReviewSource {
	const { generation, call, command, escalation, state, target } = review;
	const { destination, source } = target;
	const check = () => {
		if (!isCurrent() || !state.isCurrent()) {
			throw new StaleSandboxHandleError({ operation: 'acquire' });
		}
	};

	const { signal } = state;

	return Object.freeze<ShellReviewSource>({
		command,
		destination,
		...(escalation !== undefined &&
			signal !== undefined && {
				escalation,
				signal,
				recordDecision(choice: EscalationDecision) {
					if (!isCurrent() || !state.isCurrent()) {
						throw new InvalidSandboxRequestError({ operation: 'exec' });
					}

					state.record(choice, extension);
				}
			}),
		async negotiateCopy(requirements) {
			check();

			const result = await generation.negotiateCopy(
				context,
				source,
				requirements
			);

			check();

			return result;
		},
		async copy(input) {
			const options = acquireOptions(input, extension);

			check();

			const copy = await generation.copy(context, source, options);

			try {
				check();
				options.signal?.throwIfAborted();
				checkCopiedSandbox(copy.sandbox, options, extension);
				append?.({
					kind: 'review-copy',
					toolCallId: call.toolCallId,
					source: destination,
					policy: copy.sandbox.profile.policy,
					decider: { kind: 'permission-extension', extension }
				});

				return copy;
			} catch (error) {
				return rethrowCopyError(error, () => copy.close(), {
					operation: 'dispose',
					providerId: copy.sandbox.providerId,
					backendId: copy.sandbox.backendId
				});
			}
		}
	});
}
