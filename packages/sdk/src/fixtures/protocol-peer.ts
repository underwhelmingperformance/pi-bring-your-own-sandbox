import type { EventBus } from '@earendil-works/pi-coding-agent';
import { createEventBus } from '@earendil-works/pi-coding-agent';

import { bindProtocolAddress } from '../protocol-address.js';
import { PROTOCOL_MAJOR, PROVIDER_CHANNEL } from '../protocol-envelope.js';
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
		service: {
			id,
			label: 'Independent protocol fixture',
			profiles: fixtureProfiles(
				{
					processKinds: ['argv'],
					terminationScope: 'workload',
					exitStatus: 'guaranteed',
					operations: [],
					shells: []
				},
				{
					hostWorkspaceWrites: [true],
					hostUserData: ['denied'],
					hostSystemFiles: ['read-only'],
					network: [false]
				}
			)
		}
	};
}

class IndependentBroker {
	readonly #identity: string;

	constructor(id: string) {
		this.#identity = id;
	}

	acquire() {
		return Promise.reject(new Error('Fixture only.'));
	}

	negotiate() {
		return Promise.reject(new Error('Fixture only.'));
	}

	resolveReviewSource(): undefined {
		return;
	}

	status() {
		return Promise.resolve({
			generationId: this.#identity,
			state: 'idle' as const
		});
	}

	providers() {
		return Promise.resolve([]);
	}
}

export function brokerReply(id = 'independent') {
	return {
		type: 'broker',
		candidateId: 'fixture-candidate',
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
				major: Object.hasOwn(fields, 'major') ? major : PROTOCOL_MAJOR,
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
