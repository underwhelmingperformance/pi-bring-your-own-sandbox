import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import { discoverBroker, discoverProviders } from './discovery.js';
import { InvalidSandboxDeclarationError } from './errors.js';
import { rehydrateSandboxError } from './errors.js';
import { imageProvider } from './fixtures/image-provider.js';
import { fixtureEvents } from './fixtures/protocol-peer.js';
import {
	brokerReply,
	providerReply,
	respond
} from './fixtures/protocol-peer.js';
import { protocolAddress } from './protocol-address.js';
import {
	onProtocolRequest,
	PROTOCOL_MAJOR,
	PROVIDER_CHANNEL,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import { registerSandboxProvider } from './provider-registration.js';
import { createSandboxOperationContext } from './provider-test-contexts.js';
import { localRuntimeBindings } from './runtime-participant.js';

it('reads an independent provider declaration on the actual Pi event bus', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = providerReply();

	respond(events, 'pi-byos:provider', reply);

	expect(
		discoverProviders(events).map((service) => ({
			id: service.id,
			label: service.label,
			profiles: service.profiles,
			fields: Object.keys(service).toSorted((a, b) => a.localeCompare(b))
		}))
	).toStrictEqual([
		{
			id: reply.id,
			label: 'Independent protocol fixture',
			profiles: reply.service.profiles,
			fields: ['id', 'label', 'profiles', 'protocol']
		}
	]);
	expect(discoverBroker(events)).toBeUndefined();
});

it('snapshots whole profiles from an independent peer before asynchronous work', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = providerReply();
	const [offered] = reply.service.profiles.open;

	respond(events, 'pi-byos:provider', reply);

	const [service] = discoverProviders(events);

	if (offered === undefined || service === undefined) {
		throw new Error('The fixture must declare one open profile.');
	}

	const expected = { ...offered };

	Object.assign(offered, { capabilities: ['files.write'] });

	expect({
		profiles: service.profiles,
		frozen: Object.isFrozen(service.profiles.open[0]?.capabilities)
	}).toStrictEqual({
		profiles: { open: [expected], copy: [] },
		frozen: true
	});
});

it('accepts an independent broker service and preserves its method receiver', async () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = brokerReply();

	respond(events, 'pi-byos:runtime', reply);

	const service = discoverBroker(events);
	const status = await service?.status({
		cwd: '/fixture',
		sessionManager: SessionManager.inMemory('/fixture')
	});

	expect({
		id: service?.id,
		generationId: status?.generationId,
		state: status?.state
	}).toStrictEqual({
		id: 'independent',
		generationId: 'independent',
		state: 'idle'
	});
});

it.each(['candidateId', 'brokerId', 'extensionSource'] as const)(
	'rejects an advertisement outside the broker pin when %s differs',
	(field) => {
		const events = fixtureEvents(import.meta.filename);
		const reply = brokerReply();
		const local = protocolAddress(events);
		const identity = {
			...local,
			extensionSource: '/fixture-peer.ts',
			buildId: 'fixture',
			packageVersion: '1.0.0'
		};
		const pin = {
			brokerId: reply.id,
			candidateId: reply.candidateId,
			identity
		};
		const mismatched =
			field === 'extensionSource'
				? { ...pin, identity: { ...identity, extensionSource: '/other.ts' } }
				: { ...pin, [field]: 'different' };

		respond(events, RUNTIME_CHANNEL, reply);

		expect(discoverBroker(events, pin)?.id).toBe(reply.id);
		expect(() => discoverBroker(events, mismatched)).toThrow(
			expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
		);
	}
);

it('collects every synchronous reply before validating and ignores late replies', async () => {
	const events = fixtureEvents(import.meta.filename);
	const late = providerReply('late');

	respond(events, 'pi-byos:provider', providerReply('first'));
	respond(events, 'pi-byos:provider', late, true);
	respond(events, 'pi-byos:provider', providerReply('last'));

	const result = discoverProviders(events);

	await Promise.resolve();

	expect(result.map((provider) => provider.id)).toStrictEqual([
		'first',
		'last'
	]);
});

it.each([
	[
		'wrong kind',
		{ ...providerReply(), kind: 'other' },
		'InvalidSandboxDeclarationError'
	],
	[
		'missing version',
		{ ...providerReply(), major: undefined },
		'InvalidSandboxDeclarationError'
	],
	[
		'future service',
		{ ...providerReply(), major: 3 },
		'IncompatibleSandboxProtocolError'
	],
	[
		'fractional feature level',
		{ ...providerReply(), featureLevel: 1.5 },
		'InvalidSandboxDeclarationError'
	],
	[
		'mismatched id',
		{ ...providerReply(), id: 'different' },
		'InvalidSandboxDeclarationError'
	],
	[
		'missing label',
		{
			...providerReply(),
			service: { ...providerReply().service, label: undefined }
		},
		'InvalidSandboxDeclarationError'
	],
	...(
		[
			[
				'retired exec capability',
				[
					{
						...providerReply().service.profiles.open[0],
						capabilities: ['exec']
					}
				]
			],
			[
				'unknown capability',
				[
					{
						...providerReply().service.profiles.open[0],
						capabilities: ['pty']
					}
				]
			],
			['missing open profiles', []]
		] as const
	).map(
		([label, open]) =>
			[
				label,
				{
					...providerReply(),
					service: { ...providerReply().service, profiles: { open, copy: [] } }
				},
				'InvalidSandboxDeclarationError'
			] as [string, unknown, string]
	)
])('fails on %s even alongside a valid provider', (_label, reply, name) => {
	const events = fixtureEvents(import.meta.filename);

	respond(events, 'pi-byos:provider', reply);
	respond(events, 'pi-byos:provider', providerReply('valid'));

	expect(() => discoverProviders(events)).toThrow(
		expect.objectContaining({ name })
	);
});

it.each(['same', 'different'])(
	'rejects multiple brokers with %s identities',
	(identity) => {
		const events = fixtureEvents(import.meta.filename);

		respond(events, 'pi-byos:runtime', brokerReply('same'));
		respond(events, 'pi-byos:runtime', brokerReply(identity));

		expect(() => discoverBroker(events)).toThrow(
			expect.objectContaining({ name: 'DuplicateBrokerError' })
		);
	}
);

it('rejects a repeated provider callback', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = providerReply();

	respond(events, 'pi-byos:provider', reply);
	respond(events, 'pi-byos:provider', reply);

	expect(() => discoverProviders(events)).toThrow(
		expect.objectContaining({ name: 'DuplicateProviderError' })
	);
});

function providerHost() {
	return {
		events: fixtureEvents(import.meta.filename),
		getActiveTools() {
			throw new Error('Factory loading.');
		},
		sendMessage() {
			throw new Error('Unexpected diagnostic message.');
		},
		appendEntry() {
			throw new Error('Unexpected diagnostic entry.');
		},
		on: vi.fn(() => vi.fn())
	};
}

function configContext() {
	return {
		...createSandboxOperationContext(),
		pi: {
			cwd: '/workspace',
			sessionManager: SessionManager.inMemory('/workspace')
		}
	};
}

it('captures typed provider configuration without allocating during discovery', async () => {
	const pi = providerHost();
	const config = { image: 'fixture' };
	const settings = { readRoots: ['/readable'] };
	const create = vi.fn(() => ({
		configure: () => Promise.resolve({ configuration: config, settings }),
		open: imageProvider.open
	}));

	registerSandboxProvider(pi, import.meta.filename, {
		id: imageProvider.id,
		label: imageProvider.label,
		profiles: imageProvider.profiles,
		create
	});

	const [service] = localRuntimeBindings(pi).providers;

	expect({ id: service?.id, creates: create.mock.calls.length }).toStrictEqual({
		id: imageProvider.id,
		creates: 0
	});

	const configured = await service?.configure?.(configContext());
	const open: unknown = expect.any(Function);

	settings.readRoots.push('/later');
	expect({ configured, creates: create.mock.calls.length }).toStrictEqual({
		configured: { open, settings: { readRoots: ['/readable'] } },
		creates: 1
	});
});

it.each([
	{
		outcome: 'malformed',
		configure: () => Promise.resolve({ image: 'unexpected' })
	},
	{
		outcome: 'rejected',
		configure: () => Promise.reject(new Error('Invalid async settings.'))
	}
])(
	'rejects $outcome asynchronous configuration before opening',
	async ({ configure }) => {
		const pi = providerHost();

		Reflect.apply(registerSandboxProvider, undefined, [
			pi,
			import.meta.filename,
			{
				id: imageProvider.id,
				label: imageProvider.label,
				profiles: imageProvider.profiles,
				create: () => ({
					configure,
					open: () => Promise.reject(new Error('Opening must not occur.'))
				})
			}
		]);

		const [service] = localRuntimeBindings(pi).providers;

		await expect(service?.configure?.(configContext())).rejects.toMatchObject({
			name: 'InvalidSandboxConfigError',
			providerId: imageProvider.id,
			extensionSource: import.meta.filename
		});
	}
);

it('rejects an independent broker without a status method', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = brokerReply();

	Object.defineProperty(reply.service, 'status', { value: undefined });
	respond(events, 'pi-byos:runtime', reply);
	expect(() => discoverBroker(events)).toThrow(
		expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
	);
});

it.each([
	{
		label: 'provider declaration',
		channel: PROVIDER_CHANNEL,
		request: 'get-providers',
		replies: [{ ...providerReply(), id: 'mismatch' }],
		discover: discoverProviders
	},
	{
		label: 'broker service',
		channel: RUNTIME_CHANNEL,
		request: 'get-broker',
		replies: [{ ...brokerReply(), id: 'mismatch' }],
		discover: discoverBroker
	}
] as const)(
	'identifies the peer in an error for a $label',
	({ channel, request, replies, discover }) => {
		expect.assertions(1);

		const events = fixtureEvents(import.meta.filename);

		for (const [index, reply] of replies.entries()) {
			onProtocolRequest(
				events,
				channel,
				{
					major: PROTOCOL_MAJOR,
					featureLevel: 0,
					packageVersion: '1.0.0',
					buildId: `fixture-${String(index)}\u{200B}`,
					extensionSource: `/fixture-${String(index)}.ts\n`
				},
				request,
				() => reply,
				channel === PROVIDER_CHANNEL ? 'advertisement' : 'reply'
			);
		}

		try {
			discover(events);
		} catch (error) {
			if (!(error instanceof InvalidSandboxDeclarationError)) {
				throw error;
			}

			const last = String(replies.length - 1);
			const message = String.raw`Invalid protocol service reply from /fixture-${last}.ts\x0a (build fixture-${last}\u{200b}).`;
			const rehydrated = rehydrateSandboxError(error, undefined, {
				operation: 'configure'
			});
			const serialised = JSON.stringify([error, rehydrated]);
			const details: unknown = JSON.parse(serialised);
			const name = 'InvalidSandboxDeclarationError';

			expect({
				details,
				messages: [error.message, rehydrated.message]
			}).toStrictEqual({
				details: [
					{ name, operation: 'discover' },
					{ name, operation: 'configure' }
				],
				messages: [message, message]
			});
		}
	}
);
