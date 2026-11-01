import type { EventBus } from '@earendil-works/pi-coding-agent';

import { isDiscoveryRequest } from './discovery.js';
import type { DiscoveryRequestV1 } from './protocol.js';
import { isRecord } from './validation.js';

const CHANNEL = 'pi-byos:diagnostics:v1:shell-integration';

export function registerShellIntegrationDiagnostics(events: EventBus): void {
	events.on(CHANNEL, (request) => {
		if (isDiscoveryRequest(request)) {
			request.reply({
				kind: 'pi-byos.shell-integration',
				discoveryVersion: 1
			});
		}
	});
}

export function describeShellIntegration(events: EventBus): string {
	const replies: unknown[] = [];
	let isCollecting = true;

	try {
		events.emit(CHANNEL, {
			kind: 'pi-byos.discover',
			discoveryVersion: 1,
			reply(value: unknown) {
				if (isCollecting) {
					replies.push(value);
				}
			}
		} satisfies DiscoveryRequestV1);
	} catch {
		return 'Pi shell integration: request status unavailable; routing unverified.';
	} finally {
		isCollecting = false;
	}

	if (replies.length === 0) {
		return 'Pi shell integration: not requested; routing unverified.';
	}

	const hasValidReplies = replies.every(
		(reply) =>
			isRecord(reply) &&
			reply.kind === 'pi-byos.shell-integration' &&
			reply.discoveryVersion === 1
	);

	return hasValidReplies
		? 'Pi shell integration: requested; routing unverified.'
		: 'Pi shell integration: request status unavailable; routing unverified.';
}
