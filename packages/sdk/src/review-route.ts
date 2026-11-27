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
	isSandboxError
} from './errors.js';
import { snapshotEscalationRequest } from './escalation-ledger.js';
import { protocolAddress } from './protocol-address.js';
import type {
	ProtocolEnvelope,
	ProtocolIdentity
} from './protocol-envelope.js';
import { collectProtocolReplies, REVIEW_CHANNEL } from './protocol-envelope.js';
import {
	copyOptionsSchema,
	reviewSourceSchema,
	sourceReply
} from './protocol-payloads.js';
import { checkDemand, sharedFeatureLevel } from './protocol-version.js';
import type { ReviewUnavailableReason } from './review-identities.js';
import { checkedCopy, copyOptions } from './sandbox-copy.js';
import { checker } from './schemas.js';

const isSource = checker(sourceReply);
const isReviewSource = checker(reviewSourceSchema);

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
		readonly source: ShellReviewSource;
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

		if (!isReviewSource(source)) {
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
		source: bindReviewSource(resolved.source, local, resolved.peer)
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
	source: ShellReviewSource,
	local: ProtocolIdentity,
	peer: ProtocolEnvelope
): ShellReviewSource {
	const escalation =
		source.escalation === undefined
			? undefined
			: snapshotEscalationRequest(source.escalation);

	const { signal, recordDecision } = source;

	return Object.freeze<ShellReviewSource>({
		destination: source.destination,
		...(escalation !== undefined &&
			signal !== undefined &&
			recordDecision !== undefined && {
				escalation,
				signal,
				recordDecision: recordDecision.bind(source)
			}),
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

			return checkedCopy(copy, options, local.extensionSource);
		}
	});
}
