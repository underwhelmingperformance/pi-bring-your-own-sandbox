import type { EventBus } from '@earendil-works/pi-coding-agent';

import { builtinProviders } from './builtin-providers.js';
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
import { checker } from './schemas.js';
import {
	advertisementSchema,
	brokerServiceSchema,
	discoveryRequestSchema,
	providerServiceSchema
} from './service-schemas.js';
import { snapshotCapabilities, snapshotProviderInfo } from './validation.js';

export const isDiscoveryRequest = checker(discoveryRequestSchema);

const isAdvertisement = checker(advertisementSchema);

export const isProviderService = checker(providerServiceSchema);
export const isBrokerService = checker(brokerServiceSchema);

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
	const ids = new Set(
		builtinProviders.providers.map((provider) => provider.id)
	);

	return collect(events, PROVIDER_DISCOVERY_CHANNEL, 'pi-byos.provider').map(
		({ id, service }) => {
			if (!isProviderService(service) || service.id !== id) {
				throw new InvalidSandboxDeclarationError({
					operation: 'discover',
					providerId: id
				});
			}

			if (ids.has(id)) {
				throw new DuplicateProviderError({
					operation: 'discover',
					providerId: id
				});
			}

			ids.add(id);

			return Object.freeze({
				...snapshotProviderInfo(service),
				...(service.outsideSandbox !== undefined && {
					outsideSandbox: Object.freeze({
						label: service.outsideSandbox.label,
						capabilities: snapshotCapabilities(
							service.outsideSandbox.capabilities
						),
						policy: Object.freeze({ ...service.outsideSandbox.policy }),
						configure: service.outsideSandbox.configure.bind(
							service.outsideSandbox
						)
					})
				}),
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
			guardVersion: service.guardVersion,
			id,
			acquire: service.acquire.bind(service),
			negotiate: service.negotiate.bind(service),
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
