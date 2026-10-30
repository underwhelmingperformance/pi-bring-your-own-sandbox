import { createEventBus } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { respond } from './fixtures/protocol-peer.js';
import {
	describeShellIntegration,
	registerShellIntegrationDiagnostics
} from './pi-integration-status.js';

it('reports a loaded integration without allocating or verifying tool ownership', () => {
	const events = createEventBus();
	const before = describeShellIntegration(events);
	registerShellIntegrationDiagnostics(events);
	expect({ before, after: describeShellIntegration(events) }).toStrictEqual({
		before: 'Pi shell integration: not requested; routing unverified.',
		after: 'Pi shell integration: requested; routing unverified.'
	});
});

it.each([
	{ kind: 'pi-byos.shell-integration', discoveryVersion: 2 },
	{ kind: 'unexpected', discoveryVersion: 1 }
])('reports an unrecognised diagnostic reply as unavailable: %j', (reply) => {
	const events = createEventBus();
	respond(events, 'pi-byos:diagnostics:v1:shell-integration', reply);
	expect(describeShellIntegration(events)).toBe(
		'Pi shell integration: request status unavailable; routing unverified.'
	);
});

it('ignores a diagnostic reply after collection closes', async () => {
	const events = createEventBus();
	respond(
		events,
		'pi-byos:diagnostics:v1:shell-integration',
		{ kind: 'pi-byos.shell-integration', discoveryVersion: 1 },
		true
	);
	const result = describeShellIntegration(events);
	await Promise.resolve();
	expect(result).toBe(
		'Pi shell integration: not requested; routing unverified.'
	);
});
