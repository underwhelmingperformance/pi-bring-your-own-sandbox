import type { EventBus } from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';
import { Type } from 'typebox';

import { protocolAddress } from './protocol-address.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	collectProtocolReplies,
	invalidProtocolServiceReply,
	onProtocolRequest,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import { isValidAtFeatureLevel } from './protocol-schema.js';
import {
	checkDemand,
	sharedFeatureLevel,
	unavailableFeature
} from './protocol-version.js';
import { checker, nonEmptyStringSchema, recordSchema } from './schemas.js';

interface RuntimeService {
	readonly id: string;
}

const isReply = checker(
	Type.Object(
		{
			type: nonEmptyStringSchema,
			id: nonEmptyStringSchema,
			service: recordSchema
		},
		{ additionalProperties: false }
	)
);

export function publishRuntimeService(
	events: EventBus,
	type: string,
	schema: TSchema,
	service: RuntimeService
): void {
	const local = protocolAddress(events);

	onProtocolRequest(
		events,
		RUNTIME_CHANNEL,
		local,
		`get-${type}`,
		(request) => {
			if (request.major !== local.major) {
				return { type: 'incompatible-major' };
			}

			if (
				!isValidAtFeatureLevel(
					schema,
					Math.min(local.featureLevel, request.featureLevel),
					service
				)
			) {
				return { type: 'unrepresentable-demand' };
			}

			return { type, id: service.id, service };
		}
	);
}

export function discoverRuntimeServices<Service extends RuntimeService>(
	events: EventBus,
	type: string,
	schema: TSchema,
	isService: (value: unknown) => value is Service,
	duplicateError: (
		peer: ProtocolIdentity
	) => Error = invalidProtocolServiceReply
): readonly Service[] {
	const local = protocolAddress(events);
	const ids = new Set<string>();

	return collectProtocolReplies(events, RUNTIME_CHANNEL, local, {
		type: `get-${type}`
	}).map((peer) => {
		const level = sharedFeatureLevel(local, peer);
		const value = peer.payload;

		if (peer.kind === 'reply' && value.type === 'unrepresentable-demand') {
			throw unavailableFeature(
				type,
				level,
				local.featureLevel < peer.featureLevel ? local : peer
			);
		}

		if (
			peer.kind !== 'reply' ||
			!isReply(value) ||
			value.type !== type ||
			!isService(value.service) ||
			value.id !== value.service.id
		) {
			throw invalidProtocolServiceReply(peer);
		}

		if (ids.has(value.id)) {
			throw duplicateError(peer);
		}

		ids.add(value.id);
		checkDemand(schema, value.service, local, peer, type);

		return value.service;
	});
}
