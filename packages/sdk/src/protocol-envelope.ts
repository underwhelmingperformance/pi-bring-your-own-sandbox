import { randomUUID } from 'node:crypto';

import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { cleanDisplayText } from './display-text.js';
import { InvalidSandboxDeclarationError } from './errors.js';
import { packageVersionSchema } from './protocol-version.js';
import {
	checker,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	positiveIntegerSchema
} from './schemas.js';
import { isRecord } from './validation.js';

export const RUNTIME_CHANNEL = 'pi-byos:runtime';
export const PROVIDER_CHANNEL = 'pi-byos:provider';
export const REVIEW_CHANNEL = 'pi-byos:review';

export const PROTOCOL_MAJOR = 1;
export const PROTOCOL_FEATURE_LEVEL = 0;

const identityFields = {
	buildId: nonEmptyStringSchema,
	packageVersion: packageVersionSchema,
	extensionSource: nonEmptyStringSchema,
	major: positiveIntegerSchema,
	featureLevel: nonNegativeIntegerSchema
};
const protocolPayloadSchema = Type.Object({ type: nonEmptyStringSchema });

export const protocolEnvelopeSchema = Type.Object(
	{
		...identityFields,
		kind: Type.Enum(['advertisement', 'request', 'reply']),
		requestId: nonEmptyStringSchema,
		payload: protocolPayloadSchema
	},
	{ additionalProperties: false }
);

export type ProtocolEnvelope = Readonly<Static<typeof protocolEnvelopeSchema>>;
export type ProtocolIdentity = Omit<
	ProtocolEnvelope,
	'kind' | 'payload' | 'requestId'
>;

interface ProtocolPayload {
	readonly type: string;
	readonly [field: string]: unknown;
}

type Channel =
	typeof RUNTIME_CHANNEL | typeof PROVIDER_CHANNEL | typeof REVIEW_CHANNEL;

const isEnvelope = checker(protocolEnvelopeSchema);

type Listener = (message: unknown) => void;

const dispatchers = new WeakMap<EventBus, Map<Channel, Set<Listener>>>();

function listen(
	events: EventBus,
	channel: Channel,
	listener: Listener
): () => void {
	let channels = dispatchers.get(events);

	if (channels === undefined) {
		channels = new Map();
		dispatchers.set(events, channels);
	}

	let listeners = channels.get(channel);

	if (listeners === undefined) {
		const handlers = new Set<Listener>();

		events.on(channel, (message) => {
			const currentHandlers = [...handlers];

			for (const handle of currentHandlers) {
				handle(message);
			}
		});
		channels.set(channel, handlers);
		listeners = handlers;
	}

	listeners.add(listener);

	return () => {
		listeners.delete(listener);
	};
}

export function invalidProtocolServiceReply(
	peer: ProtocolIdentity
): InvalidSandboxDeclarationError {
	return new InvalidSandboxDeclarationError({
		operation: 'discover',
		protocolMessage: cleanDisplayText(
			`Invalid protocol service reply from ${peer.extensionSource} (build ${peer.buildId}).`
		)
	});
}

export function collectProtocolReplies(
	events: EventBus,
	channel: Channel,
	identity: ProtocolIdentity,
	payload: ProtocolPayload
): readonly ProtocolEnvelope[] {
	const requestId = randomUUID();
	const candidates: unknown[] = [];
	const stop = listen(events, channel, (message) => {
		if (
			isRecord(message) &&
			message['requestId'] === requestId &&
			message['kind'] !== 'request'
		) {
			candidates.push(message);
		}
	});

	try {
		events.emit(channel, {
			...identity,
			kind: 'request',
			requestId,
			payload
		} satisfies ProtocolEnvelope);
	} finally {
		stop();
	}

	return candidates.map((message) => {
		if (!isEnvelope(message)) {
			const source = isRecord(message) ? message['extensionSource'] : undefined;
			const build = isRecord(message) ? message['buildId'] : undefined;

			throw new InvalidSandboxDeclarationError({
				operation: 'discover',
				...(typeof source === 'string' &&
					typeof build === 'string' && {
						protocolMessage: cleanDisplayText(
							`Invalid protocol envelope from ${source} (build ${build}).`
						)
					})
			});
		}

		return message;
	});
}

export function onProtocolRequest(
	events: EventBus,
	channel: Channel,
	identity: ProtocolIdentity,
	type: string,
	respond: (request: ProtocolEnvelope) => ProtocolPayload | undefined,
	kind: 'advertisement' | 'reply' = 'reply'
): () => void {
	return listen(events, channel, (message) => {
		if (
			!isEnvelope(message) ||
			message.kind !== 'request' ||
			message.payload.type !== type
		) {
			return;
		}

		const payload = respond(message);

		if (payload !== undefined) {
			events.emit(channel, {
				...identity,
				kind,
				requestId: message.requestId,
				payload
			} satisfies ProtocolEnvelope);
		}
	});
}
