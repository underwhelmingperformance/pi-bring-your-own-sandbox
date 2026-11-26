import type { BrokerReviewSource } from './broker-review.js';
import type { SessionIdentity } from './context.js';
import { inspectContext } from './context.js';
import type {
	ReviewedToolCall,
	SandboxContext,
	SandboxHost,
	ShellReviewLookup,
	ShellReviewSource
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import {
	IncompatibleSandboxProtocolError,
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	isSandboxError
} from './errors.js';
import type {
	EscalationDecision,
	EscalationRequest
} from './escalation-ledger.js';
import { snapshotEscalationRequest } from './escalation-ledger.js';
import { protocolAddress } from './protocol-address.js';
import type {
	ProtocolEnvelope,
	ProtocolIdentity
} from './protocol-envelope.js';
import { collectProtocolReplies, REVIEW_CHANNEL } from './protocol-envelope.js';
import { copyOptionsSchema, sourceReply } from './protocol-payloads.js';
import { checkDemand, sharedFeatureLevel } from './protocol-version.js';
import type { ReviewUnavailableReason } from './review-identities.js';
import {
	checkCopiedSandbox,
	copyOptions,
	rethrowCopyError
} from './sandbox-copy.js';
import { checker } from './schemas.js';

const isSource = checker(sourceReply);
const pending = new WeakMap<
	EscalationRequest,
	{
		readonly client: SandboxHost;
		readonly sessionId: string;
		readonly workspace: string;
		readonly record: (decision: EscalationDecision) => void;
	}
>();

export function recordEscalationDecision(
	pi: SandboxHost,
	context: SandboxContext,
	request: EscalationRequest,
	decision: unknown
): void {
	const session = inspectContext(context, 'exec');
	const proof = pending.get(request);

	if (
		proof === undefined ||
		proof.client !== pi ||
		proof.sessionId !== session.sessionId ||
		proof.workspace !== session.workspace ||
		(decision !== 'allow' && decision !== 'deny')
	) {
		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}

	proof.record(decision);
}

/**
Whether a loaded BYOS shell extension answers review queries. A route can still
decline a particular call.
*/
export function hasShellReviewRoute(pi: SandboxHost): boolean {
	const local = protocolAddress(pi.events);

	return collectProtocolReplies(pi.events, REVIEW_CHANNEL, local, {
		type: 'get-availability'
	}).some((reply) => {
		sharedFeatureLevel(local, reply);

		return reply.kind === 'reply' && reply.payload.type === 'available';
	});
}

/**
Resolve a pending shell call through the broker elected in this Pi runtime.
*/
export function findShellReviewSource(
	pi: SandboxHost,
	context: SandboxContext,
	call: ReviewedToolCall
): ShellReviewLookup {
	const session = inspectContext(context, 'acquire');
	const local = protocolAddress(pi.events);
	let replies: readonly ProtocolEnvelope[];

	try {
		replies = collectProtocolReplies(pi.events, REVIEW_CHANNEL, local, {
			type: 'find-source',
			sessionId: session.sessionId,
			toolName: call.toolName,
			toolCallId: call.toolCallId
		});
	} catch (error) {
		if (isSandboxError(error, InvalidSandboxDeclarationError)) {
			return { ok: false, reason: 'invalid-source' };
		}

		throw error;
	}

	const failures = new Set<ReviewUnavailableReason>();
	const sources: {
		readonly source: BrokerReviewSource;
		readonly peer: ProtocolEnvelope;
	}[] = [];

	for (const reply of replies) {
		try {
			sharedFeatureLevel(local, reply);
		} catch (error) {
			if (isSandboxError(error, IncompatibleSandboxProtocolError)) {
				failures.add('incompatible-protocol');
				continue;
			}

			throw error;
		}

		const payload = reply.payload;

		if (
			reply.kind !== 'reply' ||
			!isSource(payload) ||
			payload.toolCallId !== call.toolCallId
		) {
			failures.add('invalid-source');
			continue;
		}

		if (!payload.ok) {
			failures.add(payload.reason);
			continue;
		}

		const broker = ensureSandboxService(pi);
		const source = broker.resolveReviewSource?.(
			context,
			{
				toolName: call.toolName,
				toolCallId: call.toolCallId,
				sessionId: session.sessionId,
				requestId: reply.requestId,
				extensionSource: local.extensionSource
			},
			payload.sourceId
		);

		if (source === undefined) {
			failures.add('invalid-source');
			continue;
		}

		sources.push({ source, peer: reply });
	}

	if (sources.length > 1) {
		return { ok: false, reason: 'ambiguous' };
	}

	const [resolved] = sources;

	if (resolved === undefined) {
		const reason = unavailableReasons.find((candidate) =>
			failures.has(candidate)
		);

		return { ok: false, reason: reason ?? 'unsupported-tool' };
	}

	return {
		ok: true,
		source: bindReviewSource(pi, session, resolved.source, local, resolved.peer)
	};
}

const unavailableReasons = [
	'destination-unavailable',
	'not-selected',
	'unknown-call',
	'ambiguous',
	'incompatible-protocol',
	'invalid-source',
	'unsupported-tool'
] as const satisfies readonly ReviewUnavailableReason[];

function bindReviewSource(
	pi: SandboxHost,
	session: SessionIdentity,
	source: BrokerReviewSource,
	local: ProtocolIdentity,
	peer: ProtocolEnvelope
): ShellReviewSource {
	const escalation =
		source.escalation === undefined
			? undefined
			: snapshotEscalationRequest(source.escalation);

	if (escalation !== undefined && source.recordDecision !== undefined) {
		pending.set(escalation, {
			client: pi,
			sessionId: session.sessionId,
			workspace: session.workspace,
			record: source.recordDecision
		});
	}

	return Object.freeze<ShellReviewSource>({
		destination: source.destination,
		...(escalation !== undefined && { escalation }),
		negotiateCopy(requirements) {
			checkDemand(
				copyOptionsSchema,
				requirements ?? {},
				local,
				peer,
				'review copy'
			);

			return source.negotiateCopy(requirements);
		},
		async copy(input) {
			const options = copyOptions(input, local.extensionSource);

			checkDemand(copyOptionsSchema, options, local, peer, 'review copy');

			const copy = await source.copy(options);

			try {
				checkCopiedSandbox(copy.sandbox, options, local.extensionSource);

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
