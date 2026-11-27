import { randomUUID } from 'node:crypto';

import type { EventBus } from '@earendil-works/pi-coding-agent';

import type { SandboxHost } from '../contracts.js';
import { discoverBroker } from '../discovery.js';
import type { BrokerService } from '../protocol.js';
import { protocolAddress } from '../protocol-address.js';
import { localRuntimeBindings } from '../runtime-participant.js';
import { publishBroker } from '../service.js';

export function ensureFixtureBroker(
	events: EventBus,
	create: (id: string) => BrokerService
): BrokerService {
	return discoverBroker(events) ?? publishBroker(events, randomUUID(), create);
}

export function publishFixtureBroker(
	pi: SandboxHost,
	create: (id: string) => BrokerService
): BrokerService {
	const candidateId = randomUUID();
	const service = publishBroker(pi.events, candidateId, create);

	localRuntimeBindings(pi).pin = {
		identity: protocolAddress(pi.events),
		candidateId,
		brokerId: service.id
	};

	return service;
}
