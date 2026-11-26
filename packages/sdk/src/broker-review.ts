import { homedir } from 'node:os';

import { Type } from 'typebox';

import type { SandboxContext, ShellReviewSource } from './contracts.js';
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
import {
	escalationRequestSchema,
	snapshotEscalationRequest
} from './escalation-ledger.js';
import type { SandboxGeneration } from './generation.js';
import { passthroughProvider } from './passthrough-provider.js';
import type { CopySourceIdentity } from './protocol.js';
import type { ReviewRegistration } from './review-identities.js';
import {
	checkCopiedSandbox,
	copyOptions,
	rethrowCopyError
} from './sandbox-copy.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

const reviewCall = Type.Object(
	{
		toolName: Type.Union([Type.Literal('bash'), Type.Literal('powershell')]),
		toolCallId: nonEmptyStringSchema
	},
	{ additionalProperties: false }
);
const reviewRequest = Type.Object(
	{
		call: reviewCall,
		escalation: Type.Optional(escalationRequestSchema),
		decisionDeadline: Type.Optional(Type.Number())
	},
	{ additionalProperties: false }
);
const isReviewRequest = checker(reviewRequest);

export function reviewRegistrationInput(input: unknown) {
	if (
		!isReviewRequest(input) ||
		(input.escalation === undefined) !==
			(input.decisionDeadline === undefined) ||
		(input.escalation !== undefined &&
			input.escalation.toolCallId !== input.call.toolCallId)
	) {
		throw new InvalidSandboxRequestError({
			operation: 'acquire',
			detail: { kind: 'request', field: 'review' }
		});
	}

	const { escalation, call, decisionDeadline } = input;

	return Object.freeze({
		call: Object.freeze({ ...call }),
		...(escalation !== undefined && {
			escalation: snapshotEscalationRequest(escalation)
		}),
		...(decisionDeadline !== undefined && { decisionDeadline })
	});
}

type PermissionDecider = Extract<
	NonNullable<EscalationEntry['decider']>,
	{ kind: 'permission-extension' }
>;

type ReviewDecision =
	| { readonly choice: EscalationDecision; readonly decider: PermissionDecider }
	| { readonly choice: 'conflict' };

export interface BrokerReviewRegistration extends ReviewRegistration {
	readonly isReviewed: () => boolean;
	readonly decision: () => ReviewDecision | undefined;
	readonly claimDecision: () => ReviewDecision | undefined;
}

export class ReviewState {
	#isReviewed = false;
	#isClaimed = false;
	#decision: ReviewDecision | undefined;
	readonly #deadline: number | undefined;

	constructor(deadline?: number) {
		this.#deadline = deadline;
	}

	isCurrent(): boolean {
		return this.#deadline === undefined || performance.now() < this.#deadline;
	}

	markReviewed(): void {
		this.#isReviewed = true;
	}

	bind(registration: ReviewRegistration): BrokerReviewRegistration {
		return Object.freeze<BrokerReviewRegistration>({
			...registration,
			isReviewed: () => this.#isReviewed,
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
	readonly route: ReturnType<typeof reviewRegistrationInput>;
	readonly state: ReviewState;
	readonly target: ReviewDestination;
	readonly generation: SandboxGeneration;
}

export interface BrokerReviewSource extends ShellReviewSource {
	readonly recordDecision?: (choice: EscalationDecision) => void;
}

export async function describeReviewDestination(
	generation: SandboxGeneration,
	context: SandboxContext,
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

	if (policy === undefined) {
		if (status.failure !== undefined) {
			throw status.failure;
		}

		const ordinary = await generation.negotiate(context);

		if (!ordinary.ok) {
			throw ordinary.error;
		}

		policy = ordinary.profile.policy;
	}

	const isHost = proposed?.kind === 'host' || selection.source === 'default';
	const providerId = isHost ? passthroughProvider.id : selection.providerId;
	const label = isHost
		? passthroughProvider.label
		: (status.providerLabel ?? providerId);
	const backendId =
		escalation === undefined && status.state === 'ready'
			? status.backendId
			: undefined;
	const workspace = backendId === undefined ? undefined : status.workspace;
	const location =
		workspace ??
		(isHost
			? Object.freeze({
					root: context.cwd,
					home: homedir(),
					pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
					relationship: 'shared',
					description: 'The host checkout.'
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
): BrokerReviewSource {
	const { generation, route, state, target } = review;
	const { destination, source } = target;
	const { escalation } = route;
	const check = () => {
		if (!isCurrent() || !state.isCurrent()) {
			throw new StaleSandboxHandleError({ operation: 'acquire' });
		}
	};

	return Object.freeze<BrokerReviewSource>({
		destination,
		...(escalation !== undefined && { escalation }),
		...(escalation !== undefined && {
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
			const options = copyOptions(input, extension);

			check();

			const copy = await generation.copy(context, source, options);

			try {
				check();
				options.signal?.throwIfAborted();
				checkCopiedSandbox(copy.sandbox, options, extension);
				append?.({
					kind: 'review-copy',
					toolCallId: route.call.toolCallId,
					source: destination,
					policy: copy.sandbox.policy,
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
