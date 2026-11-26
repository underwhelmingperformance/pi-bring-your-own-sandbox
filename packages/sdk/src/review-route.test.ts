import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import type { BrokerReviewSource } from './broker-review.js';
import { inspectContext } from './context.js';
import type { SandboxHost } from './contracts.js';
import { fixtureEvents, respond } from './fixtures/protocol-peer.js';
import { defaultPolicy } from './policy-model.js';
import { protocolAddress } from './protocol-address.js';
import { onProtocolRequest, REVIEW_CHANNEL } from './protocol-envelope.js';
import { findReviewRequest } from './protocol-payloads.js';
import { ReviewIdentities } from './review-identities.js';
import { findShellReviewSource, hasShellReviewRoute } from './review-route.js';
import { checker } from './schemas.js';
import { ensureBroker } from './service.js';

const isQuery = checker(findReviewRequest);
const call = { toolName: 'bash', toolCallId: 'call-1' };

function host(): SandboxHost {
	return {
		events: fixtureEvents(import.meta.filename),
		on: vi.fn(() => vi.fn()),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => []
	};
}

function context() {
	return {
		cwd: '/project',
		sessionManager: SessionManager.inMemory('/project')
	};
}

const unexpected = () =>
	Promise.reject(new Error('Unexpected broker operation.'));

function broker(
	pi: SandboxHost,
	registry: ReviewIdentities<BrokerReviewSource>
) {
	return ensureBroker(pi.events, (id) => ({
		id,
		acquire: unexpected,
		copy: unexpected,
		negotiate: unexpected,
		close: unexpected,
		status: unexpected,
		providers: unexpected,
		resolveReviewSource: (scope, query, token) =>
			registry.resolve(inspectContext(scope, 'acquire'), query, token)?.value
	}));
}

it.each([true, false])(
	'reports whether a shell review route answers: %s',
	(isAvailable) => {
		const pi = host();

		onProtocolRequest(
			pi.events,
			REVIEW_CHANNEL,
			protocolAddress(pi.events),
			'get-availability',
			() => (isAvailable ? { type: 'available' } : undefined)
		);

		expect(hasShellReviewRoute(pi)).toBe(isAvailable);
	}
);

it.each([
	{ reply: undefined, reason: 'unsupported-tool' },
	{
		reply: {
			type: 'source',
			ok: false,
			toolCallId: 'call-1',
			reason: 'unknown-call'
		},
		reason: 'unknown-call'
	},
	{
		reply: {
			type: 'source',
			ok: false,
			toolCallId: 'call-1',
			reason: 'not-selected'
		},
		reason: 'not-selected'
	},
	{
		reply: {
			type: 'source',
			ok: false,
			toolCallId: 'call-1',
			reason: 'destination-unavailable'
		},
		reason: 'destination-unavailable'
	},
	{
		reply: {
			type: 'source',
			ok: true,
			toolCallId: 'another-call',
			sourceId: 'unissued'
		},
		reason: 'invalid-source'
	},
	{
		reply: { type: 'incompatible-major', major: 2 },
		reason: 'incompatible-protocol'
	}
] as const)('returns the typed reason $reason', ({ reply, reason }) => {
	const pi = host();

	if (reply !== undefined) {
		respond(pi.events, REVIEW_CHANNEL, reply, false, 'find-source');
	}

	expect(findShellReviewSource(pi, context(), call)).toStrictEqual({
		ok: false,
		reason
	});
});

it('rejects a reply with executable fields and leaves its functions unused', () => {
	const pi = host();
	const copy = vi.fn();
	const recordDecision = vi.fn();

	respond(
		pi.events,
		REVIEW_CHANNEL,
		{
			type: 'source',
			ok: true,
			toolCallId: call.toolCallId,
			sourceId: 'unissued',
			copy,
			recordDecision
		},
		false,
		'find-source'
	);

	expect({
		result: findShellReviewSource(pi, context(), call),
		copy: copy.mock.calls,
		record: recordDecision.mock.calls
	}).toStrictEqual({
		result: { ok: false, reason: 'invalid-source' },
		copy: [],
		record: []
	});
});

it('ignores a reply belonging to another query', () => {
	const pi = host();
	const local = protocolAddress(pi.events);

	onProtocolRequest(pi.events, REVIEW_CHANNEL, local, 'find-source', () => {
		pi.events.emit(REVIEW_CHANNEL, {
			...local,
			kind: 'reply',
			requestId: 'unsolicited',
			payload: {
				type: 'source',
				ok: true,
				toolCallId: call.toolCallId,
				sourceId: 'unissued'
			}
		});
	});

	expect(findShellReviewSource(pi, context(), call)).toStrictEqual({
		ok: false,
		reason: 'unsupported-tool'
	});
});

it.each([
	{ issuer: 'foreign', count: 1, reason: 'invalid-source' },
	{ issuer: 'local', count: 2, reason: 'ambiguous' }
] as const)(
	'rejects $count $issuer claims as $reason',
	({ issuer, count, reason }) => {
		const pi = host();
		const scope = context();
		const registry = new ReviewIdentities<BrokerReviewSource>();
		const foreign = new ReviewIdentities<BrokerReviewSource>();
		const owner = issuer === 'local' ? registry : foreign;
		const local = protocolAddress(pi.events);
		const fixtures = Array.from({ length: count }, (_, index) =>
			owner.register(inspectContext(scope, 'acquire'), call, {
				destination: {
					providerId: 'fixture',
					label: String(index),
					policy: defaultPolicy
				},
				copy: vi.fn(),
				negotiateCopy: vi.fn()
			})
		);

		broker(pi, registry);

		for (const fixture of fixtures) {
			onProtocolRequest(
				pi.events,
				REVIEW_CHANNEL,
				local,
				'find-source',
				(request) => {
					if (!isQuery(request.payload)) {
						return;
					}

					const sourceId = fixture.issue({
						toolName: request.payload.toolName,
						toolCallId: request.payload.toolCallId,
						sessionId: request.payload.sessionId,
						requestId: request.requestId,
						extensionSource: request.extensionSource
					});

					return {
						type: 'source',
						ok: true,
						toolCallId: call.toolCallId,
						sourceId
					};
				}
			);
		}

		expect(findShellReviewSource(pi, scope, call)).toStrictEqual({
			ok: false,
			reason
		});
	}
);
