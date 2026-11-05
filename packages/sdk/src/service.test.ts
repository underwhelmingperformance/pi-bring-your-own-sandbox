import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { discoverBroker } from './discovery.js';
import { brokerReply, respond } from './fixtures/protocol-peer.js';
import { ensureBroker } from './service.js';

function fixtureContext() {
	return {
		cwd: '/fixture',

		sessionManager: SessionManager.inMemory('/fixture')
	};
}

it('publishes synchronously and constructs exactly one service on first use', () => {
	const events = createEventBus();
	let constructions = 0;

	const create = (id: string) => {
		constructions++;
		expect(discoverBroker(events)?.id).toBe(id);

		return brokerReply(id).service;
	};

	const first = ensureBroker(events, create);
	const second = ensureBroker(events, create);

	expect({ ids: [first.id, second.id], constructions }).toStrictEqual({
		ids: [first.id, first.id],
		constructions: 1
	});
});

it('retains a failed bootstrap so a later caller cannot create a replacement', async () => {
	const events = createEventBus();
	let constructions = 0;

	const create = () => {
		constructions++;

		throw new Error('deliberate construction failure');
	};

	expect(() => ensureBroker(events, create)).toThrow(
		expect.objectContaining({ name: 'SandboxInitialisationError' })
	);

	const failed = ensureBroker(events, create);

	await expect(failed.providers(fixtureContext())).rejects.toMatchObject({
		name: 'SandboxInitialisationError'
	});
	expect(constructions).toBe(1);
});

it('rejects re-entrant acquisition during construction without creating another service', async () => {
	const events = createEventBus();
	let reentrant: Promise<unknown> | undefined;
	let constructions = 0;
	const service = ensureBroker(events, (id) => {
		constructions++;

		const pending = ensureBroker(events, () => {
			throw new Error('Must reuse the published service.');
		});

		reentrant = pending.providers(fixtureContext());

		return brokerReply(id).service;
	});

	await expect(reentrant).rejects.toMatchObject({
		name: 'SandboxInitialisationError'
	});
	expect({ id: discoverBroker(events)?.id, constructions }).toStrictEqual({
		id: service.id,
		constructions: 1
	});
});

it('does not construct a replacement for an incompatible advertisement', () => {
	const events = createEventBus();

	respond(events, 'pi-byos:discovery:v1:brokers', {
		...brokerReply(),
		serviceVersions: [2]
	});
	expect(() =>
		ensureBroker(events, () => {
			throw new Error('Must not create a replacement.');
		})
	).toThrow(
		expect.objectContaining({ name: 'IncompatibleSandboxProtocolError' })
	);
});
