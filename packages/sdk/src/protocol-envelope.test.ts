import { createEventBus } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { InvalidSandboxDeclarationError } from './errors.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	collectProtocolReplies,
	onProtocolRequest,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';

const caller: ProtocolIdentity = {
	buildId: 'caller',
	packageVersion: '1.0.0',
	extensionSource: '/consumer.ts',
	major: 1,
	featureLevel: 0
};
const responder: ProtocolIdentity = {
	...caller,
	buildId: 'responder',
	extensionSource: '/provider.ts'
};

it('collects replies with the matching request ID on the runtime channel', () => {
	const events = createEventBus();

	onProtocolRequest(
		events,
		RUNTIME_CHANNEL,
		responder,
		'get-broker',
		(request) => {
			events.emit(RUNTIME_CHANNEL, {
				...responder,
				kind: 'reply',
				requestId: 'another-request',
				payload: { type: 'broker', id: 'unrelated' }
			});

			return { type: 'broker', id: request.extensionSource };
		}
	);

	const replies = collectProtocolReplies(events, RUNTIME_CHANNEL, caller, {
		type: 'get-broker'
	});

	expect(
		replies.map(({ requestId, ...reply }) => ({
			matched: requestId.length > 0,
			...reply
		}))
	).toStrictEqual([
		{
			...responder,
			kind: 'reply',
			matched: true,
			payload: { type: 'broker', id: '/consumer.ts' }
		}
	]);
});

it('rejects a malformed matching reply at the receiver', () => {
	const events = createEventBus();

	events.on(RUNTIME_CHANNEL, (message) => {
		if (
			typeof message !== 'object' ||
			message === null ||
			!('requestId' in message) ||
			!('kind' in message) ||
			message.kind !== 'request'
		) {
			return;
		}

		events.emit(RUNTIME_CHANNEL, {
			...responder,
			major: -1,
			kind: 'reply',
			requestId: message.requestId,
			payload: { type: 'broker' }
		});
	});

	expect(() =>
		collectProtocolReplies(events, RUNTIME_CHANNEL, caller, {
			type: 'get-broker'
		})
	).toThrow(InvalidSandboxDeclarationError);
});
