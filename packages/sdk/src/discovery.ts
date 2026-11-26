import type { EventBus } from '@earendil-works/pi-coding-agent';

import { builtinProviders } from './builtin-providers.js';
import { DuplicateBrokerError, DuplicateProviderError } from './errors.js';
import { providerInfoSchema } from './policy-model.js';
import type { BrokerService, ProviderServiceV1 } from './protocol.js';
import { protocolAddress } from './protocol-address.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	collectProtocolReplies,
	invalidProtocolServiceReply,
	PROVIDER_CHANNEL,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import { brokerReply, providerAdvertisement } from './protocol-payloads.js';
import { projectOffer } from './protocol-schema.js';
import { checkDemand, sharedFeatureLevel } from './protocol-version.js';
import { acquireOptionsSchema } from './request-schemas.js';
import { checker } from './schemas.js';
import { brokerServiceSchema } from './service-schemas.js';
import { snapshotProviderInfo } from './validation.js';

export const isBrokerService = checker(brokerServiceSchema);

const isBrokerReply = checker(brokerReply);
const isProviderAdvertisement = checker(providerAdvertisement);
const isProviderInfo = checker(providerInfoSchema);

export function protocolIdentity({
	buildId,
	packageVersion,
	extensionSource,
	major,
	featureLevel
}: ProtocolIdentity): ProtocolIdentity {
	return { buildId, packageVersion, extensionSource, major, featureLevel };
}

export function discoverProviders(
	events: EventBus
): readonly ProviderServiceV1[] {
	const local = protocolAddress(events);
	const ids = new Set(
		builtinProviders.providers.map((provider) => provider.id)
	);

	return collectProtocolReplies(events, PROVIDER_CHANNEL, local, {
		type: 'get-providers'
	}).map((reply) => {
		const level = sharedFeatureLevel(local, reply);
		const value = projectOffer(providerAdvertisement, reply.payload, level);

		if (
			reply.kind !== 'advertisement' ||
			!isProviderAdvertisement(value) ||
			value.service.id !== value.id
		) {
			throw invalidProtocolServiceReply(reply);
		}

		const { id, service } = value;

		if (ids.has(id)) {
			throw new DuplicateProviderError({
				operation: 'discover',
				providerId: id
			});
		}

		ids.add(id);

		return Object.freeze({
			...snapshotProviderInfo(service),
			protocol: protocolIdentity(reply),
			configure: service.configure.bind(service)
		});
	});
}

function boundBroker(
	service: BrokerService,
	local: ProtocolIdentity,
	peer: ProtocolIdentity
): BrokerService {
	const level = sharedFeatureLevel(local, peer);

	return Object.freeze<BrokerService>({
		id: service.id,
		...(service.planEscalation !== undefined && {
			planEscalation: service.planEscalation.bind(service)
		}),
		acquire(context, options) {
			checkDemand(acquireOptionsSchema, options ?? {}, local, peer, 'acquire');

			return service.acquire(context, options);
		},
		negotiate(context, options) {
			checkDemand(
				acquireOptionsSchema,
				options ?? {},
				local,
				peer,
				'negotiate'
			);

			return service.negotiate(context, options);
		},
		copy(context, source, options) {
			checkDemand(acquireOptionsSchema, options ?? {}, local, peer, 'copy');

			return service.copy(context, source, options);
		},
		close: service.close.bind(service),
		async status(context) {
			const status = await service.status(context);

			return { ...status, protocol: protocolIdentity(peer) };
		},
		async providers(context) {
			const providers = await service.providers(context);

			return providers.flatMap((provider) => {
				const offer = projectOffer(providerInfoSchema, provider, level);

				return isProviderInfo(offer) ? [offer] : [];
			});
		}
	});
}

export function discoverBroker(events: EventBus): BrokerService | undefined {
	const local = protocolAddress(events);
	const replies = collectProtocolReplies(events, RUNTIME_CHANNEL, local, {
		type: 'get-broker'
	});

	if (replies.length > 1) {
		throw new DuplicateBrokerError({ operation: 'discover' });
	}

	const [reply] = replies;

	if (reply === undefined) {
		return undefined;
	}

	const level = sharedFeatureLevel(local, reply);
	const payload = projectOffer(brokerReply, reply.payload, level);

	if (
		reply.kind !== 'reply' ||
		!isBrokerReply(payload) ||
		payload.service.id !== payload.id
	) {
		throw invalidProtocolServiceReply(reply);
	}

	return boundBroker(payload.service, local, reply);
}
