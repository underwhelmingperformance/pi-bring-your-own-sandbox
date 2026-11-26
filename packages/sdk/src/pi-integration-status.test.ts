import { expect, it } from 'vitest';

import { fixtureEvents } from './fixtures/protocol-peer.js';
import { respond } from './fixtures/protocol-peer.js';
import {
	describeShellIntegration,
	registerShellIntegrationDiagnostics
} from './pi-integration-status.js';

it('reports a loaded integration without allocating or verifying tool ownership', () => {
	const events = fixtureEvents(import.meta.filename);
	const before = describeShellIntegration(events);

	registerShellIntegrationDiagnostics(events);
	expect({ before, after: describeShellIntegration(events) }).toStrictEqual({
		before: 'Pi shell integration: not requested; routing unverified.',
		after: 'Pi shell integration: requested; routing unverified.'
	});
});

it.each([{ type: 'shell-integration', major: 2 }, { type: 'unexpected' }])(
	'reports an unrecognised diagnostic reply as unavailable: %j',
	(reply) => {
		const events = fixtureEvents(import.meta.filename);

		respond(events, 'pi-byos:runtime', reply, false, 'get-shell-integration');
		expect(describeShellIntegration(events)).toBe(
			'Pi shell integration: request status unavailable; routing unverified.'
		);
	}
);

it('ignores a diagnostic reply after collection closes', async () => {
	const events = fixtureEvents(import.meta.filename);

	respond(
		events,
		'pi-byos:runtime',
		{ type: 'shell-integration' },
		true,
		'get-shell-integration'
	);

	const result = describeShellIntegration(events);

	await Promise.resolve();
	expect(result).toBe(
		'Pi shell integration: not requested; routing unverified.'
	);
});
