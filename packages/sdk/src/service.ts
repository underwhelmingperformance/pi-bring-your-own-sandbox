import { randomUUID } from 'node:crypto';

import type { EventBus } from '@earendil-works/pi-coding-agent';

import { isBrokerService } from './discovery.js';
import {
	InvalidSandboxDeclarationError,
	isSandboxError,
	SandboxInitialisationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import type { BrokerService } from './protocol.js';
import { protocolAddress } from './protocol-address.js';
import { brokerOffers } from './protocol-broker-results.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { onProtocolRequest, RUNTIME_CHANNEL } from './protocol-envelope.js';
import { brokerReply } from './protocol-payloads.js';
import { projectReply } from './protocol-version.js';

export function publishBroker(
	events: EventBus,
	candidateId: string,
	create: (id: string) => BrokerService,
	id = randomUUID()
): BrokerService {
	let target: BrokerService | undefined;
	let failure = new SandboxInitialisationError({
		operation: 'discover'
	});

	const invoke = <Result>(
		operation: (service: BrokerService) => Promise<Result>
	): Promise<Result> => {
		if (target === undefined) {
			return Promise.reject(failure);
		}

		try {
			return operation(target);
		} catch (error) {
			if (isSandboxError(error)) {
				return Promise.reject(error);
			}

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

	const service = Object.freeze<BrokerService>({
		copy: (context, source, options) =>
			invoke((broker) => broker.copy(context, source, options)),
		id,
		acquire: (context, options) =>
			invoke((broker) => broker.acquire(context, options)),
		negotiate: (context, options) =>
			invoke((broker) => broker.negotiate(context, options)),
		planEscalation: (context, options) =>
			invoke(
				(broker) =>
					broker.planEscalation?.(context, options) ??
					Promise.reject(
						new UnsupportedSandboxCapabilityError({ operation: 'acquire' })
					)
			),
		prepareReview: (context, route) =>
			invoke(
				(broker) =>
					broker.prepareReview?.(context, route) ??
					Promise.reject(
						new UnsupportedSandboxCapabilityError({ operation: 'acquire' })
					)
			),
		resolveReviewSource: (context, query, id) =>
			target?.resolveReviewSource?.(context, query, id),
		close: (context) => invoke((broker) => broker.close(context)),
		status: (context) => invoke((broker) => broker.status(context)),
		providers: (context) => invoke((broker) => broker.providers(context))
	});

	const identity = protocolAddress(events);
	const offer = (request: ProtocolIdentity) =>
		request.major === identity.major
			? brokerOffers(service, identity, request)
			: service;

	try {
		onProtocolRequest(
			events,
			RUNTIME_CHANNEL,
			identity,
			'get-broker',
			(request) =>
				projectReply(
					brokerReply,
					{
						type: 'broker',
						candidateId,
						id,
						service: offer(request)
					},
					identity,
					request
				)
		);

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
