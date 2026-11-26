import type { EventBus } from '@earendil-works/pi-coding-agent';

import { protocolAddress } from './protocol-address.js';
import {
	collectProtocolReplies,
	onProtocolRequest,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import { sharedFeatureLevel } from './protocol-version.js';

export function registerShellIntegrationDiagnostics(events: EventBus): void {
	onProtocolRequest(
		events,
		RUNTIME_CHANNEL,
		protocolAddress(events),
		'get-shell-integration',
		() => ({
			type: 'shell-integration'
		})
	);
}

export function describeShellIntegration(events: EventBus): string {
	const local = protocolAddress(events);

	try {
		const replies = collectProtocolReplies(events, RUNTIME_CHANNEL, local, {
			type: 'get-shell-integration'
		});

		if (replies.length === 0) {
			return 'Pi shell integration: not requested; routing unverified.';
		}

		const isMatches = replies.every((reply) => {
			sharedFeatureLevel(local, reply);

			return (
				reply.kind === 'reply' && reply.payload.type === 'shell-integration'
			);
		});

		if (isMatches) {
			return 'Pi shell integration: requested; routing unverified.';
		}
	} catch {
		return 'Pi shell integration: request status unavailable; routing unverified.';
	}

	return 'Pi shell integration: request status unavailable; routing unverified.';
}
