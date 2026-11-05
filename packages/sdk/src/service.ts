import { randomUUID } from 'node:crypto';

import type { EventBus } from '@earendil-works/pi-coding-agent';

import {
	discoverBroker,
	isBrokerService,
	isDiscoveryRequest
} from './discovery.js';
import {
	InvalidSandboxDeclarationError,
	SandboxInitialisationError
} from './errors.js';
import type { BrokerServiceV1, ServiceAdvertisementV1 } from './protocol.js';
import { BROKER_DISCOVERY_CHANNEL } from './protocol.js';

export function ensureBroker(
	events: EventBus,
	create: (id: string) => BrokerServiceV1
): BrokerServiceV1 {
	const existing = discoverBroker(events);

	if (existing !== undefined) {
		return existing;
	}

	const id = randomUUID();
	let target: BrokerServiceV1 | undefined;
	let failure = new SandboxInitialisationError({
		operation: 'discover'
	});

	const invoke = <Result>(
		operation: (service: BrokerServiceV1) => Promise<Result>
	): Promise<Result> => {
		if (target === undefined) {
			return Promise.reject(failure);
		}

		try {
			return operation(target);
		} catch (error) {
			return Promise.reject(
				new SandboxInitialisationError(
					{
						operation: 'discover'
					},
					{ cause: error }
				)
			);
		}
	};

	const service = Object.freeze<BrokerServiceV1>({
		id,
		acquire: (context, options) =>
			invoke((broker) => broker.acquire(context, options)),
		negotiate: (context, options) =>
			invoke((broker) => broker.negotiate(context, options)),
		close: (context) => invoke((broker) => broker.close(context)),
		status: (context) => invoke((broker) => broker.status(context)),
		providers: (context) => invoke((broker) => broker.providers(context))
	});
	const advertisement: ServiceAdvertisementV1 = Object.freeze({
		kind: 'pi-byos.broker',
		discoveryVersion: 1,
		serviceVersions: Object.freeze([1]),
		id,
		service
	});

	try {
		events.on(BROKER_DISCOVERY_CHANNEL, (request) => {
			if (isDiscoveryRequest(request)) {
				request.reply(advertisement);
			}
		});

		const created: unknown = create(id);

		if (!isBrokerService(created) || created.id !== id) {
			throw new InvalidSandboxDeclarationError({
				operation: 'discover'
			});
		}

		target = created;
	} catch (error) {
		failure = new SandboxInitialisationError(
			{
				operation: 'discover'
			},
			{ cause: error }
		);

		throw failure;
	}

	return service;
}
