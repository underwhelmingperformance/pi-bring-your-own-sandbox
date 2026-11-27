import type { EventBus } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import { brokerStatusSchema } from './broker-status-schema.js';
import { builtinProviders } from './builtin-providers.js';
import { bindSandbox } from './consumer-wire-adapter.js';
import { negotiationSchema } from './consumer-wire-schemas.js';
import { DuplicateBrokerError, DuplicateProviderError } from './errors.js';
import { providerInfoSchema } from './policy-model.js';
import type { BrokerService } from './protocol.js';
import { protocolAddress } from './protocol-address.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	collectProtocolReplies,
	invalidProtocolServiceReply,
	PROVIDER_CHANNEL,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import type { BrokerPin } from './protocol-payloads.js';
import { brokerReply, providerAdvertisement } from './protocol-payloads.js';
import { projectOffer } from './protocol-schema.js';
import { checkDemand, sharedFeatureLevel } from './protocol-version.js';
import { acquireOptionsSchema } from './request-schemas.js';
import type { DiscoveredProvider } from './runtime-participant.js';
import { areProtocolIdentitiesEqual } from './runtime-participant.js';
import { checker, denseArray } from './schemas.js';
import { brokerServiceSchema } from './service-schemas.js';
import { snapshotProviderInfo } from './validation.js';

export const isBrokerService = checker(brokerServiceSchema);

const isNegotiation = checker(negotiationSchema);
const isStatus = checker(brokerStatusSchema);
const isProviderList = checker(denseArray(Type.Unknown()));

export function checkedNegotiation(value: unknown, peer: ProtocolIdentity) {
	if (!isNegotiation(value)) {
		throw invalidProtocolServiceReply(peer);
	}

	return value;
}

const isBrokerReply = checker(brokerReply);
const isProviderAdvertisement = checker(providerAdvertisement);
const isProviderInfo = checker(providerInfoSchema);

function protocolIdentity({
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
): readonly DiscoveredProvider[] {
	const local = protocolAddress(events);
	const ids = new Set(
		builtinProviders.providers.map((provider) => provider.id)
	);

	return collectProtocolReplies(events, PROVIDER_CHANNEL, local, {
		type: 'get-providers'
	}).map((reply) => {
		const level = sharedFeatureLevel(local, reply);
		const value = projectOffer(providerAdvertisement, reply.payload, level);

		if (reply.kind !== 'advertisement' || !isProviderAdvertisement(value)) {
			throw invalidProtocolServiceReply(reply);
		}

		const { service } = value;
		const { id } = service;

		if (ids.has(id)) {
			throw new DuplicateProviderError({
				operation: 'discover',
				providerId: id
			});
		}

		ids.add(id);

		return Object.freeze({
			...snapshotProviderInfo(service),
			protocol: Object.freeze(protocolIdentity(reply))
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
		resolveReviewSource: service.resolveReviewSource.bind(service),
		async acquire(context, options) {
			checkDemand(acquireOptionsSchema, options ?? {}, local, peer, 'acquire');

			return bindSandbox(await service.acquire(context, options), local, peer);
		},
		async negotiate(context, options) {
			checkDemand(
				acquireOptionsSchema,
				options ?? {},
				local,
				peer,
				'negotiate'
			);

			return checkedNegotiation(
				await service.negotiate(context, options),
				peer
			);
		},
		async status(context) {
			const status: unknown = await service.status(context);

			if (!isStatus(status)) {
				throw invalidProtocolServiceReply(peer);
			}

			return { ...status, protocol: protocolIdentity(peer) };
		},
		async providers(context) {
			const providers: unknown = await service.providers(context);

			if (!isProviderList(providers)) {
				throw invalidProtocolServiceReply(peer);
			}

			return providers.flatMap((provider) => {
				const offer = projectOffer(providerInfoSchema, provider, level);

				return isProviderInfo(offer) ? [offer] : [];
			});
		}
	});
}

export function discoverBroker(
	events: EventBus,
	pin?: BrokerPin
): BrokerService | undefined {
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
		(pin !== undefined &&
			(payload.id !== pin.brokerId ||
				payload.candidateId !== pin.candidateId ||
				!areProtocolIdentitiesEqual(reply, pin.identity)))
	) {
		throw invalidProtocolServiceReply(reply);
	}

	return boundBroker(payload.service, local, reply);
}
