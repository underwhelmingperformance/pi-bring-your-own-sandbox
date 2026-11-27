import { randomUUID } from 'node:crypto';

import type { Static } from 'typebox';
import { Type } from 'typebox';

import type { SessionIdentity } from './context.js';
import type { ReviewedToolCall } from './contracts.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

const reasonSchema = Type.Union([
	Type.Literal('unknown-call'),
	Type.Literal('unsupported-tool'),
	Type.Literal('not-selected'),
	Type.Literal('destination-unavailable'),
	Type.Literal('invalid-source'),
	Type.Literal('incompatible-protocol'),
	Type.Literal('ambiguous')
]);

export type ReviewUnavailableReason = Static<typeof reasonSchema>;

export const reviewIdentityReplySchema = Type.Union([
	Type.Object(
		{
			type: Type.Literal('source'),
			ok: Type.Literal(true),
			toolCallId: nonEmptyStringSchema,
			sourceId: nonEmptyStringSchema
		},
		{ additionalProperties: false }
	),
	Type.Object(
		{
			type: Type.Literal('source'),
			ok: Type.Literal(false),
			toolCallId: nonEmptyStringSchema,
			reason: reasonSchema
		},
		{ additionalProperties: false }
	)
]);

export const reviewQuerySchema = Type.Object(
	{
		toolName: nonEmptyStringSchema,
		toolCallId: nonEmptyStringSchema,
		requestId: nonEmptyStringSchema,
		sessionId: nonEmptyStringSchema,
		extensionSource: nonEmptyStringSchema
	},
	{ additionalProperties: false }
);

export type ReviewQuery = Readonly<Static<typeof reviewQuerySchema>>;
export const isReviewQuery = checker(reviewQuerySchema);

export interface ReviewRegistration {
	readonly issue: (query: ReviewQuery) => string | undefined;
	readonly revoke: () => void;
}

interface ReviewProof<Value> {
	readonly value: Value;
	readonly isCurrent: () => boolean;
}

interface IssuedReview<Value> {
	readonly proof: ReviewProof<Value>;
	readonly query: ReviewQuery;
	readonly workspace: string;
	readonly pendingTokens: Set<string>;
}

function areQueriesEqual(left: ReviewQuery, right: ReviewQuery): boolean {
	return (
		left.toolName === right.toolName &&
		left.toolCallId === right.toolCallId &&
		left.sessionId === right.sessionId &&
		left.requestId === right.requestId &&
		left.extensionSource === right.extensionSource
	);
}

export class ReviewIdentities<Value> {
	readonly #issued = new Map<string, IssuedReview<Value>>();
	#isClosed = false;

	register(
		session: SessionIdentity,
		call: ReviewedToolCall,
		value: Value
	): ReviewRegistration {
		const { sessionId, workspace } = session;
		const { toolName, toolCallId } = call;
		const pendingTokens = new Set<string>();
		const issuedRequests = new Set<string>();
		let isRevoked = false;
		const isCurrent = () => !isRevoked && !this.#isClosed;
		const proof = Object.freeze({ value, isCurrent });

		return Object.freeze<ReviewRegistration>({
			issue: (query) => {
				if (
					!isCurrent() ||
					!isReviewQuery(query) ||
					query.sessionId !== sessionId ||
					query.toolName !== toolName ||
					query.toolCallId !== toolCallId ||
					issuedRequests.has(query.requestId)
				) {
					return;
				}

				const token = randomUUID();

				issuedRequests.add(query.requestId);
				pendingTokens.add(token);
				this.#issued.set(token, {
					proof,
					query: Object.freeze({ ...query }),
					workspace,
					pendingTokens
				});

				return token;
			},
			revoke: () => {
				isRevoked = true;

				for (const token of pendingTokens) {
					this.#issued.delete(token);
				}

				pendingTokens.clear();
				issuedRequests.clear();
			}
		});
	}

	resolve(
		session: SessionIdentity,
		query: ReviewQuery,
		token: string
	): ReviewProof<Value> | undefined {
		const entry = this.#issued.get(token);

		if (
			entry === undefined ||
			!entry.proof.isCurrent() ||
			session.sessionId !== query.sessionId ||
			session.workspace !== entry.workspace ||
			!areQueriesEqual(entry.query, query)
		) {
			return;
		}

		this.#issued.delete(token);
		entry.pendingTokens.delete(token);

		return entry.proof;
	}

	close(): void {
		this.#isClosed = true;
		this.#issued.clear();
	}
}
