import { expect, it } from 'vitest';

import {
	ReviewIdentities,
	reviewIdentityReplySchema
} from './review-identities.js';
import { checker } from './schemas.js';

const isReply = checker(reviewIdentityReplySchema);
const session = { sessionId: 'session-1', workspace: '/checkout' };
const call = { toolName: 'bash', toolCallId: 'call-1' };
const query = {
	...call,
	sessionId: session.sessionId,
	requestId: 'query-1',
	extensionSource: '/permission-extension.js'
};
const policy = { network: false };

it('accepts a data-only identity and rejects replies with functions', () => {
	const reply = {
		type: 'source',
		ok: true,
		toolCallId: call.toolCallId,
		sourceId: 'source-1'
	};

	expect({
		identity: isReply(reply),
		legacyClosure: isReply({ type: 'source', copy: () => policy }),
		runnable: isReply({ ...reply, copy: () => policy }),
		decision: isReply({ ...reply, recordDecision: () => 'allow' })
	}).toStrictEqual({
		identity: true,
		legacyClosure: false,
		runnable: false,
		decision: false
	});
});

it.each([
	{ field: 'toolCallId', value: 'call-2' },
	{ field: 'toolName', value: 'powershell' },
	{ field: 'sessionId', value: 'session-2' },
	{ field: 'requestId', value: 'query-2' },
	{ field: 'extensionSource', value: '/other-extension.js' }
] as const)('binds each review identity to its $field', ({ field, value }) => {
	const broker = new ReviewIdentities<typeof policy>();
	const registration = broker.register(session, call, policy);
	const issued = registration.issue(query);

	if (issued === undefined) {
		throw new Error('The pending route did not issue an identity.');
	}

	expect({
		mismatch: broker.resolve(session, { ...query, [field]: value }, issued),
		match: broker.resolve(session, query, issued)?.value,
		replay: broker.resolve(session, query, issued),
		reissue: registration.issue(query)
	}).toStrictEqual({
		mismatch: undefined,
		match: policy,
		replay: undefined,
		reissue: undefined
	});
});

it('rejects unsolicited and foreign identities and revokes pending and resolved identities', () => {
	const broker = new ReviewIdentities<typeof policy>();
	const foreign = new ReviewIdentities<typeof policy>();
	const registration = broker.register(session, call, policy);
	const issued = registration.issue(query);
	const unresolvedQuery = { ...query, requestId: 'query-pending' };
	const unresolved = registration.issue(unresolvedQuery);

	if (issued === undefined || unresolved === undefined) {
		throw new Error('The pending route did not issue the identities.');
	}

	const proof = broker.resolve(session, query, issued);
	const before = {
		unsolicited: broker.resolve(session, query, 'unissued'),
		foreign: foreign.resolve(session, unresolvedQuery, unresolved),
		workspace: broker.resolve(
			{ ...session, workspace: '/other' },
			unresolvedQuery,
			unresolved
		),
		isCurrent: proof?.isCurrent()
	};

	registration.revoke();

	expect({
		before,
		after: {
			isCurrent: proof?.isCurrent(),
			unresolved: broker.resolve(session, unresolvedQuery, unresolved),
			afterRevocation: registration.issue({ ...query, requestId: 'query-3' })
		}
	}).toStrictEqual({
		before: {
			unsolicited: undefined,
			foreign: undefined,
			workspace: undefined,
			isCurrent: true
		},
		after: {
			isCurrent: false,
			unresolved: undefined,
			afterRevocation: undefined
		}
	});
});

it('revokes resolved routes when their broker closes', () => {
	const broker = new ReviewIdentities<typeof policy>();
	const registration = broker.register(session, call, policy);
	const token = registration.issue(query);

	if (token === undefined) {
		throw new Error('The pending route did not issue an identity.');
	}

	const proof = broker.resolve(session, query, token);

	broker.close();

	expect({
		active: proof?.isCurrent(),
		issued: registration.issue({ ...query, requestId: 'query-after-close' })
	}).toStrictEqual({ active: false, issued: undefined });
});
