import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { discoverBroker } from './discovery.js';
import { ensureFixtureBroker } from './fixtures/fixture-broker-service.js';
import { fixtureEvents } from './fixtures/protocol-peer.js';
import { brokerReply, respond } from './fixtures/protocol-peer.js';

function fixtureContext() {
	return {
		cwd: '/fixture',

		sessionManager: SessionManager.inMemory('/fixture')
	};
}

it('publishes synchronously and constructs exactly one service on first use', () => {
	const events = fixtureEvents(import.meta.filename);
	let constructions = 0;

	const create = (id: string) => {
		constructions++;
		expect(discoverBroker(events)?.id).toBe(id);

		return brokerReply(id).service;
	};

	const first = ensureFixtureBroker(events, create);
	const second = ensureFixtureBroker(events, create);

	expect({ ids: [first.id, second.id], constructions }).toStrictEqual({
		ids: [first.id, first.id],
		constructions: 1
	});
});

it('retains a failed bootstrap so a later caller cannot create a replacement', async () => {
	const events = fixtureEvents(import.meta.filename);
	let constructions = 0;

	const create = () => {
		constructions++;

		throw new Error('deliberate construction failure');
	};

	expect(() => ensureFixtureBroker(events, create)).toThrow(
		expect.objectContaining({ name: 'SandboxInitialisationError' })
	);

	const failed = ensureFixtureBroker(events, create);

	await expect(failed.providers(fixtureContext())).rejects.toMatchObject({
		name: 'SandboxInitialisationError'
	});
	expect(constructions).toBe(1);
});

it('rejects re-entrant acquisition during construction without creating another service', async () => {
	const events = fixtureEvents(import.meta.filename);
	let reentrant: Promise<unknown> | undefined;
	let constructions = 0;
	const service = ensureFixtureBroker(events, (id) => {
		constructions++;

		const pending = ensureFixtureBroker(events, () => {
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
	const events = fixtureEvents(import.meta.filename);

	respond(events, 'pi-byos:runtime', {
		...brokerReply(),
		major: 1
	});
	expect(() =>
		ensureFixtureBroker(events, () => {
			throw new Error('Must not create a replacement.');
		})
	).toThrow(
		expect.objectContaining({ name: 'IncompatibleSandboxProtocolError' })
	);
});
