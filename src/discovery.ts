import type { EventBus } from '@earendil-works/pi-coding-agent';

import {
	DuplicateBrokerError,
	DuplicateProviderError,
	IncompatibleSandboxProtocolError,
	InvalidSandboxDeclarationError,
	SandboxInitialisationError
} from './errors.js';
import type {
	BrokerServiceV1,
	DiscoveryRequestV1,
	ProviderServiceV1,
	ServiceAdvertisementV1
} from './protocol.js';
import {
	BROKER_DISCOVERY_CHANNEL,
	PROVIDER_DISCOVERY_CHANNEL
} from './protocol.js';
import {
	isNonEmptyString,
	isProviderInfo,
	isRecord,
	isUniqueList,
	snapshotCapabilities,
	snapshotPolicies
} from './validation.js';

export function isDiscoveryRequest(
	value: unknown
): value is DiscoveryRequestV1 {
	return (
		isRecord(value) &&
		value.kind === 'pi-byos.discover' &&
		value.discoveryVersion === 1 &&
		typeof value.reply === 'function'
	);
}

function isAdvertisement(value: unknown): value is ServiceAdvertisementV1 {
	return (
		isRecord(value) &&
		(value.kind === 'pi-byos.broker' || value.kind === 'pi-byos.provider') &&
		value.discoveryVersion === 1 &&
		isNonEmptyString(value.id) &&
		isUniqueList(
			value.serviceVersions,
			(version): version is number =>
				typeof version === 'number' &&
				Number.isSafeInteger(version) &&
				version > 0
		) &&
		value.serviceVersions.length > 0 &&
		isRecord(value.service)
	);
}

export function isProviderService(value: unknown): value is ProviderServiceV1 {
	return (
		isRecord(value) &&
		isProviderInfo(value) &&
		typeof value.configure === 'function'
	);
}

export function isBrokerService(value: unknown): value is BrokerServiceV1 {
	return (
		isRecord(value) &&
		isNonEmptyString(value.id) &&
		typeof value.acquire === 'function' &&
		typeof value.close === 'function' &&
		typeof value.status === 'function' &&
		typeof value.providers === 'function'
	);
}

function collect(
	events: EventBus,
	channel: string,
	kind: ServiceAdvertisementV1['kind']
): readonly ServiceAdvertisementV1[] {
	const replies: unknown[] = [];
	let isCollecting = true;

	try {
		events.emit(channel, {
			kind: 'pi-byos.discover',
			discoveryVersion: 1,
			reply(advertisement: unknown) {
				if (isCollecting) {
					replies.push(advertisement);
				}
			}
		} satisfies DiscoveryRequestV1);
	} catch (error) {
		throw new SandboxInitialisationError(
			{ operation: 'discover' },
			{ cause: error }
		);
	} finally {
		isCollecting = false;
	}

	return replies.map((reply) => {
		if (!isAdvertisement(reply) || reply.kind !== kind) {
			throw new InvalidSandboxDeclarationError({
				operation: 'discover'
			});
		}

		if (!reply.serviceVersions.includes(1)) {
			throw new IncompatibleSandboxProtocolError({
				operation: 'discover'
			});
		}

		return reply;
	});
}

export function discoverProviders(
	events: EventBus
): readonly ProviderServiceV1[] {
	const ids = new Set<string>();
	return collect(events, PROVIDER_DISCOVERY_CHANNEL, 'pi-byos.provider').map(
		({ id, service }) => {
			if (!isProviderService(service) || service.id !== id) {
				throw new InvalidSandboxDeclarationError({
					operation: 'discover',
					providerId: id
				});
			}

			if (id === 'passthrough' || ids.has(id)) {
				throw new DuplicateProviderError({
					operation: 'discover',
					providerId: id
				});
			}

			ids.add(id);
			return Object.freeze({
				id,
				label: service.label,
				capabilities: snapshotCapabilities(service.capabilities),
				policies: snapshotPolicies(service.policies),
				configure: service.configure.bind(service)
			});
		}
	);
}

export function discoverBroker(events: EventBus): BrokerServiceV1 | undefined {
	const services = collect(
		events,
		BROKER_DISCOVERY_CHANNEL,
		'pi-byos.broker'
	).map(({ id, service }) => {
		if (!isBrokerService(service) || service.id !== id) {
			throw new InvalidSandboxDeclarationError({
				operation: 'discover'
			});
		}

		return Object.freeze({
			id,
			acquire: service.acquire.bind(service),
			close: service.close.bind(service),
			status: service.status.bind(service),
			providers: service.providers.bind(service)
		});
	});

	if (services.length > 1) {
		throw new DuplicateBrokerError({ operation: 'discover' });
	}

	return services[0];
}
