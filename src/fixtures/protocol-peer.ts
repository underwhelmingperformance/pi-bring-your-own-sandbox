import type { EventBus } from '@earendil-works/pi-coding-agent';

export function providerReply(id = 'independent') {
	return {
		kind: 'pi-byos.provider',
		discoveryVersion: 1,
		serviceVersions: [1],
		id,
		service: {
			id,
			label: 'Independent protocol fixture',
			capabilities: { operations: ['exec'], shells: [] },
			policies: {
				workspaceAccess: ['read-write'],
				filesystemScope: ['provider-default'],
				networkAccess: ['provider-default']
			},
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
		kind: 'pi-byos.broker',
		discoveryVersion: 1,
		serviceVersions: [1],
		id,
		service: new IndependentBroker(id)
	};
}

interface IndependentRequest {
	readonly kind: 'pi-byos.discover';
	readonly discoveryVersion: 1;
	readonly reply: (value: unknown) => void;
}

function isRequest(value: unknown): value is IndependentRequest {
	return (
		typeof value === 'object' &&
		value !== null &&
		'kind' in value &&
		value.kind === 'pi-byos.discover' &&
		'discoveryVersion' in value &&
		value.discoveryVersion === 1 &&
		'reply' in value &&
		typeof value.reply === 'function'
	);
}

export function respond(
	events: EventBus,
	channel: string,
	advertisement: unknown,
	isLate = false
) {
	events.on(channel, (request) => {
		if (!isRequest(request)) {
			return;
		}

		const reply = request.reply;
		if (isLate) {
			queueMicrotask(() => {
				reply(advertisement);
			});
			return;
		}

		reply(advertisement);
	});
}
