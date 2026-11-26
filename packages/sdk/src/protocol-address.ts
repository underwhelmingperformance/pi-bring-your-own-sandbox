import type { EventBus } from '@earendil-works/pi-coding-agent';

import type { SandboxHost } from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import { protocolBuild } from './protocol-build.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { PROTOCOL_FEATURE_LEVEL, PROTOCOL_MAJOR } from './protocol-envelope.js';

const addresses = new WeakMap<EventBus, ProtocolIdentity>();

export function hasProtocolAddress(events: EventBus): boolean {
	return addresses.has(events);
}

export function isPiBound(pi: SandboxHost): boolean {
	try {
		pi.getActiveTools();

		return true;
	} catch {
		return false;
	}
}

export function bindProtocolAddress(
	events: EventBus,
	extensionSource: string
): ProtocolIdentity {
	if (typeof extensionSource !== 'string' || extensionSource.length === 0) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	const existing = addresses.get(events);

	if (existing !== undefined) {
		if (existing.extensionSource !== extensionSource) {
			throw new InvalidSandboxRequestError({ operation: 'configure' });
		}

		return existing;
	}

	const identity = Object.freeze({
		...protocolBuild(),
		extensionSource,
		major: PROTOCOL_MAJOR,
		featureLevel: PROTOCOL_FEATURE_LEVEL
	});

	addresses.set(events, identity);

	return identity;
}

export function protocolAddress(events: EventBus): ProtocolIdentity {
	const identity = addresses.get(events);

	if (identity === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	return identity;
}
