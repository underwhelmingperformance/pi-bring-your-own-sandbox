import type { EventBus } from '@earendil-works/pi-coding-agent';

import { isSandboxError, SandboxInitialisationError } from '../errors.js';
import { protocolAddress } from '../protocol-address.js';

export function fixtureProtocolAddress(events: EventBus) {
	try {
		return protocolAddress(events);
	} catch (error) {
		if (!isSandboxError(error, SandboxInitialisationError)) {
			throw error;
		}

		return;
	}
}
