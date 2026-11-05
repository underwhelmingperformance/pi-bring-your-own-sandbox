import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { InvalidSandboxConfigError, registerSandboxProvider } from './api.js';
import { discoverBroker, discoverProviders } from './discovery.js';
import { imageProvider } from './fixtures/image-provider.js';
import {
	brokerReply,
	providerReply,
	respond
} from './fixtures/protocol-peer.js';

it('accepts an independently authored provider on the actual Pi event bus', () => {
	const events = createEventBus();
	const reply = providerReply();

	respond(events, 'pi-byos:discovery:v1:providers', reply);

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
	const events = createEventBus();
	const reply = providerReply();

	respond(events, 'pi-byos:discovery:v1:providers', reply);

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
	const events = createEventBus();
	const reply = brokerReply();

	respond(events, 'pi-byos:discovery:v1:brokers', reply);

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
	const events = createEventBus();
	const late = providerReply('late');

	respond(events, 'pi-byos:discovery:v1:providers', providerReply('first'));
	respond(events, 'pi-byos:discovery:v1:providers', late, true);
	respond(events, 'pi-byos:discovery:v1:providers', providerReply('last'));

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
		{ ...providerReply(), discoveryVersion: undefined },
		'InvalidSandboxDeclarationError'
	],
	[
		'future service',
		{ ...providerReply(), serviceVersions: [2] },
		'IncompatibleSandboxProtocolError'
	],
	[
		'duplicate versions',
		{ ...providerReply(), serviceVersions: [1, 1] },
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
	const events = createEventBus();

	respond(events, 'pi-byos:discovery:v1:providers', reply);
	respond(events, 'pi-byos:discovery:v1:providers', providerReply('valid'));

	expect(() => discoverProviders(events)).toThrow(
		expect.objectContaining({ name })
	);
});

it.each(['same', 'different'])(
	'rejects multiple brokers with %s identities',
	(identity) => {
		const events = createEventBus();

		respond(events, 'pi-byos:discovery:v1:brokers', brokerReply('same'));
		respond(events, 'pi-byos:discovery:v1:brokers', brokerReply(identity));

		expect(() => discoverBroker(events)).toThrow(
			expect.objectContaining({ name: 'DuplicateBrokerError' })
		);
	}
);

it('rejects a repeated provider callback', () => {
	const events = createEventBus();
	const reply = providerReply();

	respond(events, 'pi-byos:discovery:v1:providers', reply);
	respond(events, 'pi-byos:discovery:v1:providers', reply);

	expect(() => discoverProviders(events)).toThrow(
		expect.objectContaining({ name: 'DuplicateProviderError' })
	);
});

it('registers a typed provider without allocating or validating configuration', () => {
	const events = createEventBus();
	let opens = 0;

	registerSandboxProvider(
		{
			events,
			sendMessage() {
				throw new Error('Unexpected diagnostic message.');
			},
			appendEntry() {
				throw new Error('Unexpected diagnostic entry.');
			},
			on() {
				throw new Error('Registration must not subscribe to lifecycle events.');
			}
		},
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
	const events = createEventBus();

	registerSandboxProvider(
		{
			events,
			sendMessage() {
				throw new Error('Unexpected diagnostic message.');
			},
			appendEntry() {
				throw new Error('Unexpected diagnostic entry.');
			},
			on() {
				throw new Error('Unexpected lifecycle subscription.');
			}
		},
		{
			...imageProvider,
			validateConfig() {
				throw new InvalidSandboxConfigError({
					operation: 'configure',
					configurationSource: 'personal'
				});
			}
		}
	);

	const [service] = discoverProviders(events);

	expect(() => service?.configure({})).toThrow(
		expect.objectContaining({
			name: 'InvalidSandboxConfigError',
			configurationSource: 'personal'
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
		const events = createEventBus();

		registerSandboxProvider(
			{
				events,
				sendMessage() {
					throw new Error('Unexpected diagnostic message.');
				},
				appendEntry() {
					throw new Error('Unexpected diagnostic entry.');
				},
				on() {
					throw new Error('Unexpected lifecycle registration.');
				}
			},
			{
				id: imageProvider.id,
				label: imageProvider.label,
				protocolVersion: 1,
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
	const events = createEventBus();
	const defaultPolicy = {
		workspaceAccess: 'read-write',
		filesystemScope: 'provider-default',
		networkAccess: 'provider-default'
	} as const;
	const reply = providerReply();

	respond(events, 'pi-byos:discovery:v1:providers', {
		...reply,
		service: { ...reply.service, defaultPolicy }
	});

	const provider = discoverProviders(events)[0];

	expect(provider?.defaultPolicy).toStrictEqual(defaultPolicy);
	expect(Object.isFrozen(provider?.defaultPolicy)).toBe(true);

	const invalid = createEventBus();

	respond(invalid, 'pi-byos:discovery:v1:providers', {
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
		const events = createEventBus();
		const reply = providerReply();
		const defaultPolicy = {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default',
			workspaceProtection: [{ kind: 'git-metadata' }]
		};

		respond(events, 'pi-byos:discovery:v1:providers', {
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
