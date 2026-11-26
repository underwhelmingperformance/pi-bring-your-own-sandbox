import { SessionManager } from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';
import { expect, it, vi } from 'vitest';

import {
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError,
	registerSandboxProvider
} from './api.js';
import { discoverBroker, discoverProviders } from './discovery.js';
import { rehydrateSandboxError } from './errors.js';
import { imageProvider } from './fixtures/image-provider.js';
import { fixtureEvents } from './fixtures/protocol-peer.js';
import {
	brokerReply,
	providerReply,
	respond
} from './fixtures/protocol-peer.js';
import {
	onProtocolRequest,
	PROVIDER_CHANNEL,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import { discoverRuntimeServices } from './runtime-services.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

it('accepts an independently authored provider on the actual Pi event bus', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = providerReply();

	respond(events, 'pi-byos:provider', reply);

	expect(
		discoverProviders(events).map((service) => ({
			id: service.id,
			label: service.label,
			capabilities: service.capabilities,
			policies: service.policies,
			configureType: typeof service.configure
		}))
	).toStrictEqual([
		{
			id: reply.id,
			label: 'Independent protocol fixture',
			capabilities: {
				processKinds: ['argv'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: []
			},
			policies: {
				workspaceAccess: ['read-write'],
				filesystemScope: ['provider-default'],
				networkAccess: ['provider-default']
			},
			configureType: 'function'
		}
	]);
	expect(discoverBroker(events)).toBeUndefined();
});

it('snapshots metadata from an independent peer before asynchronous work', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = providerReply();

	respond(events, 'pi-byos:provider', reply);

	const services = discoverProviders(events);

	reply.service.capabilities.operations.push('files.write');

	expect(
		services.map((service) => ({
			capabilities: service.capabilities,
			frozen: Object.isFrozen(service.capabilities.operations)
		}))
	).toStrictEqual([
		{
			capabilities: {
				processKinds: ['argv'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: []
			},
			frozen: true
		}
	]);
});

it('accepts an independent broker service and preserves its method receiver', async () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = brokerReply();

	respond(events, 'pi-byos:runtime', reply);

	const service = discoverBroker(events);

	expect({
		id: service?.id,
		report: await service?.close({
			cwd: '/fixture',

			sessionManager: SessionManager.inMemory('/fixture')
		})
	}).toStrictEqual({
		id: 'independent',
		report: { confirmed: true, recoveries: [], failures: [] }
	});
});

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
		'missing method',
		{
			...providerReply(),
			service: { ...providerReply().service, configure: undefined }
		},
		'InvalidSandboxDeclarationError'
	],
	[
		'missing exec capability',
		{
			...providerReply(),
			service: {
				...providerReply().service,
				capabilities: {
					processKinds: ['argv'],
					terminationScope: 'workload',
					exitStatus: 'guaranteed',
					operations: [],
					shells: []
				}
			}
		},
		'InvalidSandboxDeclarationError'
	],
	[
		'unknown capability',
		{
			...providerReply(),
			service: {
				...providerReply().service,
				capabilities: {
					processKinds: ['argv'],
					terminationScope: 'workload',
					exitStatus: 'guaranteed',
					operations: ['exec', 'pty'],
					shells: []
				}
			}
		},
		'InvalidSandboxDeclarationError'
	],
	[
		'invalid policies',
		{
			...providerReply(),
			service: {
				...providerReply().service,
				policies: {
					workspaceAccess: [],
					filesystemScope: ['provider-default'],
					networkAccess: ['provider-default']
				}
			}
		},
		'InvalidSandboxDeclarationError'
	]
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

it('includes workspace relationships in the level-zero provider offer', () => {
	const events = fixtureEvents(import.meta.filename);

	registerSandboxProvider(
		{
			events,
			sendMessage: vi.fn(),
			appendEntry: vi.fn(),
			on: vi.fn(),
			getActiveTools() {
				throw new Error('Factory loading.');
			}
		},
		import.meta.filename,
		{
			...imageProvider,
			policies: { ...imageProvider.policies, workspaceRelationship: ['copied'] }
		}
	);
	expect(
		discoverProviders(events)[0]?.policies.workspaceRelationship
	).toStrictEqual(['copied']);
});

it('registers a typed provider without allocating or validating configuration', () => {
	const events = fixtureEvents(import.meta.filename);
	let opens = 0;

	registerSandboxProvider(
		{
			events,
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
		},
		import.meta.filename,
		{
			...imageProvider,
			open(request, context) {
				opens++;

				return imageProvider.open(request, context);
			}
		}
	);

	const [service] = discoverProviders(events);

	expect({ id: service?.id, opens }).toStrictEqual({
		id: 'fixture.image',
		opens: 0
	});
	expect(() => service?.configure({ image: 3 })).toThrow(
		expect.objectContaining({ name: 'InvalidSandboxConfigError' })
	);
});

it('preserves explicit provider configuration provenance through registration', () => {
	const events = fixtureEvents(import.meta.filename);

	registerSandboxProvider(
		{
			events,
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
		},
		import.meta.filename,
		{
			...imageProvider,
			validateConfig() {
				throw new InvalidSandboxConfigError({
					operation: 'configure',
					configurationSource: 'extension'
				});
			}
		}
	);

	const [service] = discoverProviders(events);

	expect(() => service?.configure({})).toThrow(
		expect.objectContaining({
			name: 'InvalidSandboxConfigError',
			configurationSource: 'extension'
		})
	);
});

it.each([
	{
		outcome: 'fulfilled',
		validateConfig: () => Promise.resolve({ image: 'unexpected' })
	},
	{
		outcome: 'rejected',
		validateConfig: () => Promise.reject(new Error('Invalid async settings.'))
	}
])(
	'rejects $outcome asynchronous validation before opening',
	({ validateConfig }) => {
		const events = fixtureEvents(import.meta.filename);

		registerSandboxProvider(
			{
				events,
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
			},
			import.meta.filename,
			{
				id: imageProvider.id,
				label: imageProvider.label,
				capabilities: imageProvider.capabilities,
				policies: imageProvider.policies,
				validateConfig,
				open: () => Promise.reject(new Error('Opening must not occur.'))
			}
		);

		const [service] = discoverProviders(events);

		expect(() => service?.configure({})).toThrow(
			expect.objectContaining({ name: 'InvalidSandboxConfigError' })
		);
	}
);

it('snapshots provider default policies and rejects unsupported defaults', () => {
	const events = fixtureEvents(import.meta.filename);
	const defaultPolicy = {
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	} as const;
	const reply = providerReply();

	respond(events, 'pi-byos:provider', {
		...reply,
		service: { ...reply.service, defaultPolicy }
	});

	const provider = discoverProviders(events)[0];

	expect(provider?.defaultPolicy).toStrictEqual(defaultPolicy);
	expect(Object.isFrozen(provider?.defaultPolicy)).toBe(true);

	const invalid = fixtureEvents(import.meta.filename);

	respond(invalid, 'pi-byos:provider', {
		...reply,
		service: {
			...reply.service,
			defaultPolicy: { ...defaultPolicy, networkAccess: 'denied' }
		}
	});
	expect(() => discoverProviders(invalid)).toThrow(
		expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
	);
});

it.each([false, true])(
	'requires an explicit capability for protected default policies: %s',
	(canProtect) => {
		const events = fixtureEvents(import.meta.filename);
		const reply = providerReply();
		const defaultPolicy = {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default',
			workspaceProtection: [{ kind: 'git-metadata' }]
		};

		respond(events, 'pi-byos:provider', {
			...reply,
			service: {
				...reply.service,
				defaultPolicy,
				capabilities: {
					...reply.service.capabilities,
					operations: canProtect ? ['exec', 'workspace.protection'] : ['exec']
				}
			}
		});

		if (!canProtect) {
			expect(() => discoverProviders(events)).toThrow(
				expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
			);

			return;
		}

		const provider = discoverProviders(events)[0];

		defaultPolicy.workspaceProtection.push({ kind: 'git-metadata' });
		expect({
			policy: provider?.defaultPolicy,
			frozen: Object.isFrozen(provider?.defaultPolicy?.workspaceProtection),
			resourceFrozen: Object.isFrozen(
				provider?.defaultPolicy?.workspaceProtection?.[0]
			)
		}).toStrictEqual({
			policy: {
				...defaultPolicy,
				workspaceProtection: [{ kind: 'git-metadata' }]
			},
			frozen: true,
			resourceFrozen: true
		});
	}
);

it('rejects an independent broker without a copy method', () => {
	const events = fixtureEvents(import.meta.filename);
	const reply = brokerReply();

	Object.defineProperty(reply.service, 'copy', { value: undefined });
	respond(events, 'pi-byos:runtime', reply);
	expect(() => discoverBroker(events)).toThrow(
		expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
	);
});

const serviceSchema = Type.Object({ id: nonEmptyStringSchema });
const isService = checker(serviceSchema);
const runtimeReply = {
	type: 'fixture',
	id: 'registered',
	service: { id: 'registered' }
};
const discoverFixture = (events: Parameters<typeof discoverBroker>[0]) =>
	discoverRuntimeServices(events, 'fixture', serviceSchema, isService);

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
	},
	{
		label: 'runtime service',
		channel: RUNTIME_CHANNEL,
		request: 'get-fixture',
		replies: [{ ...runtimeReply, id: 'mismatch' }],
		discover: discoverFixture
	},
	{
		label: 'duplicate runtime service',
		channel: RUNTIME_CHANNEL,
		request: 'get-fixture',
		replies: [runtimeReply, runtimeReply],
		discover: discoverFixture
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
					major: 1,
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
