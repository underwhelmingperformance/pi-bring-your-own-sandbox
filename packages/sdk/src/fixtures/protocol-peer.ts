import type { EventBus } from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';

import { UnsupportedSandboxCapabilityError } from '../errors.js';
import { bindProtocolAddress } from '../protocol-address.js';
import { PROVIDER_CHANNEL } from '../protocol-envelope.js';
import { isRecord } from '../validation.js';

import { fixtureProfiles } from './profile-fixture.js';

export function fixtureEvents(extensionSource: string) {
	const events = createEventBus();

	bindProtocolAddress(events, extensionSource);

	return events;
}

export function providerReply(id = 'independent') {
	return {
		type: 'provider',
		id,
		service: {
			id,
			label: 'Independent protocol fixture',
			profiles: fixtureProfiles(
				{
					processKinds: ['argv'],
					terminationScope: 'workload',
					exitStatus: 'guaranteed',
					operations: ['exec'],
					shells: []
				},
				{
					hostWorkspaceWrites: [true],
					hostUserData: ['denied'],
					hostSystemFiles: ['read-only'],
					network: [false]
				}
			),

			configure: (_input: unknown) => ({
				open: () => Promise.reject(new Error('Fixture only.'))
			})
		}
	};
}

class IndependentBroker {
	readonly #identity: string;
	readonly id: string;

	constructor(id: string) {
		this.id = id;
		this.#identity = id;
	}

	acquire() {
		return Promise.reject(new Error('Fixture only.'));
	}

	copy() {
		return Promise.reject(
			new UnsupportedSandboxCapabilityError({ operation: 'acquire' })
		);
	}

	negotiate() {
		return Promise.reject(new Error('Fixture only.'));
	}

	close() {
		return Promise.resolve({
			confirmed: this.id === this.#identity,
			recoveries: [],
			failures: []
		});
	}

	status() {
		return Promise.resolve({ generationId: 'fixture', state: 'idle' as const });
	}

	providers() {
		return Promise.resolve([]);
	}
}

export function brokerReply(id = 'independent') {
	return {
		type: 'broker',
		id,
		service: new IndependentBroker(id)
	};
}

export function respond(
	events: EventBus,
	channel: string,
	reply: unknown,
	isLate = false,
	requestType = channel === PROVIDER_CHANNEL ? 'get-providers' : 'get-broker'
) {
	events.on(channel, (request) => {
		if (
			!isRecord(request) ||
			request['kind'] !== 'request' ||
			!isRecord(request['payload']) ||
			request['payload']['type'] !== requestType
		) {
			return;
		}

		const send = () => {
			const fields = isRecord(reply) ? reply : {};
			const {
				major,
				featureLevel = 0,
				kind = channel === PROVIDER_CHANNEL ? 'advertisement' : 'reply',
				...payload
			} = fields;

			events.emit(channel, {
				kind,
				major: Object.hasOwn(fields, 'major') ? major : 1,
				featureLevel,
				requestId: request['requestId'],
				packageVersion: '1.0.0',
				buildId: 'fixture',
				extensionSource: '/fixture-peer.ts',
				payload: isRecord(reply) ? payload : reply
			});
		};

		if (isLate) {
			queueMicrotask(send);

			return;
		}

		send();
	});
}
