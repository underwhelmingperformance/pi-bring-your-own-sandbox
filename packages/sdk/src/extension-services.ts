import { randomUUID } from 'node:crypto';

import type { EventBus } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { SandboxErrorInfo } from './contracts.js';
import {
	IncompatibleSandboxProtocolError,
	InvalidSandboxDeclarationError,
	isSandboxError,
	SandboxInitialisationError
} from './errors.js';
import { callable, checker, nonEmptyStringSchema } from './schemas.js';
import {
	discoveryRequestSchema,
	extensionServiceAdvertisementSchema
} from './service-schemas.js';

const isReservation = checker(
	Type.Object({
		id: nonEmptyStringSchema,
		unavailable: callable<() => never>()
	})
);

const isRequest = checker(discoveryRequestSchema);
const isAdvertisement = checker(extensionServiceAdvertisementSchema);

export interface ExtensionService {
	readonly id: string;
}

export function discoverServices<Service extends ExtensionService>(
	events: EventBus,
	channel: string,
	isService: (value: unknown) => value is Service,
	duplicateError: () => Error = () =>
		new InvalidSandboxDeclarationError({ operation: 'discover' })
): readonly Service[] {
	const replies: unknown[] = [];
	const collection = { isCollecting: true };

	try {
		events.emit(channel, {
			kind: 'pi-byos.discover',
			discoveryVersion: 1,
			reply(value: unknown) {
				if (collection.isCollecting) {
					replies.push(value);
				}
			}
		});
	} catch (error) {
		throw new SandboxInitialisationError(
			{ operation: 'discover' },
			{ cause: error }
		);
	} finally {
		collection.isCollecting = false;
	}

	const ids = new Set<string>();

	return Object.freeze(
		replies.map((value) => {
			if (!isAdvertisement(value)) {
				throw new InvalidSandboxDeclarationError({ operation: 'discover' });
			}

			if (!value.serviceVersions.includes(1)) {
				throw new IncompatibleSandboxProtocolError({ operation: 'discover' });
			}

			if (!isService(value.service) || value.id !== value.service.id) {
				throw new InvalidSandboxDeclarationError({ operation: 'discover' });
			}

			if (ids.has(value.id)) {
				throw duplicateError();
			}

			ids.add(value.id);

			return value.service;
		})
	);
}

export function publishService(
	events: EventBus,
	channel: string,
	service: ExtensionService
): void {
	events.on(channel, (request) => {
		if (isRequest(request)) {
			request.reply(
				Object.freeze({
					kind: 'pi-byos.service',
					discoveryVersion: 1,
					serviceVersions: Object.freeze([1]),
					id: service.id,
					service
				})
			);
		}
	});
}

export function ensureExtensionService<Service extends ExtensionService>(
	events: EventBus,
	channel: string,
	isService: (value: unknown) => value is Service,
	create: (id: string) => Service
): Service {
	const services = discoverServices(events, channel, isService);

	if (services.length > 1) {
		throw new InvalidSandboxDeclarationError({ operation: 'discover' });
	}

	const existing = services[0];

	if (existing !== undefined) {
		return existing;
	}

	const reservations = discoverServices(
		events,
		`${channel}:bootstrap`,
		isReservation
	);

	for (const reservation of reservations) {
		reservation.unavailable();
	}

	const state: { failure: SandboxErrorInfo } = {
		failure: new SandboxInitialisationError({ operation: 'discover' })
	};
	const id = randomUUID();

	publishService(
		events,
		`${channel}:bootstrap`,
		Object.freeze({
			id,
			unavailable(): never {
				throw state.failure;
			}
		})
	);

	try {
		const service = create(id);

		if (!isService(service) || service.id !== id) {
			throw new InvalidSandboxDeclarationError({ operation: 'discover' });
		}

		publishService(events, channel, Object.freeze(service));

		return service;
	} catch (error) {
		state.failure = isSandboxError(error)
			? error
			: new SandboxInitialisationError(
					{ operation: 'discover' },
					{ cause: error }
				);

		throw state.failure;
	}
}
