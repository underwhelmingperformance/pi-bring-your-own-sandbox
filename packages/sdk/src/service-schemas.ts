import type { TObject } from 'typebox';
import { Type } from 'typebox';

import { builtinProviders } from './builtin-providers.js';
import { cleanupSelectionSchema } from './cleanup-budgets.js';
import { hostAbsolutePathSchema } from './context-schemas.js';
import type {
	AvailableSandboxProvider,
	SandboxProviderImplementation
} from './contracts.js';
import {
	providerInfoSchema,
	providerUnavailabilitySchema
} from './policy-model.js';
import type { BrokerService, ConfiguredProviderV1 } from './protocol.js';
import { sharedSettingsSchema } from './request-schemas.js';
import { callable, nonEmptyStringSchema } from './schemas.js';

// TypeBox counts own keys for compiled closed objects. Services can inherit methods.
function withKnownOwnFields<Schema extends TObject>(shape: Schema) {
	return Type.Refine(shape, (value) =>
		Object.keys(value).every((key) => Object.hasOwn(shape.properties, key))
	);
}

const sessionContext = Type.Ref('runtime.context');
const acquireOptions = Type.Optional(Type.Ref('broker.acquireOptions'));
const reviewSource = Type.Union([
	Type.Ref('broker.reviewSource'),
	Type.Undefined()
]);
const brokerServiceShape = Type.Object({
	acquire: callable<BrokerService['acquire']>(
		[sessionContext, acquireOptions],
		Type.Ref('sandbox.handle'),
		'async'
	),
	negotiate: callable<BrokerService['negotiate']>(
		[sessionContext, acquireOptions],
		Type.Ref('sandbox.negotiation'),
		'async'
	),
	resolveReviewSource: callable<BrokerService['resolveReviewSource']>(
		[sessionContext, Type.Ref('review.query'), nonEmptyStringSchema],
		reviewSource
	),
	status: callable<BrokerService['status']>(
		[sessionContext],
		Type.Ref('broker.status'),
		'async'
	),
	providers: callable<BrokerService['providers']>(
		[sessionContext],
		Type.Array(providerInfoSchema),
		'async'
	)
});

export const brokerServiceSchema = withKnownOwnFields(brokerServiceShape);

const providerIdSchema = Type.Refine(
	nonEmptyStringSchema,
	(value) => !builtinProviders.has(value)
);

const providerFactory = callable<AvailableSandboxProvider<unknown>['create']>(
	[],
	Type.Ref('provider.implementation')
);

export const providerDeclarationSchema = withKnownOwnFields(
	Type.Object({
		id: providerIdSchema,
		label: nonEmptyStringSchema,
		profiles: providerInfoSchema.properties.profiles,
		create: providerFactory
	})
);

type Implementation = SandboxProviderImplementation<unknown>;

const copyImplementation = callable<NonNullable<Implementation['copy']>>(
	[Type.Ref('provider.localCopyRequest'), Type.Ref('provider.openContext')],
	Type.Ref('provider.backend'),
	'async'
);
const persistImplementation = callable<
	NonNullable<Implementation['persistReadRoot']>
>(
	[Type.Ref('provider.persistence'), Type.Ref('provider.sharedSettings')],
	Type.Undefined(),
	'async'
);

export const providerImplementationSchema = Type.Object({
	configure: callable<Implementation['configure']>(
		[Type.Ref('provider.configContext'), Type.Ref('provider.sharedSettings')],
		Type.Ref('provider.localConfiguration'),
		'sync-or-async'
	),
	open: callable<Implementation['open']>(
		[Type.Ref('provider.localOpenRequest'), Type.Ref('provider.openContext')],
		Type.Ref('provider.backend'),
		'async'
	),
	copy: Type.Optional(copyImplementation),
	persistReadRoot: Type.Optional(persistImplementation)
});

const configuredCopy = callable<NonNullable<ConfiguredProviderV1['copy']>>(
	[Type.Ref('provider.copyRequest'), Type.Ref('provider.openContext')],
	Type.Ref('provider.backend'),
	'async'
);
const configuredPersistence = callable<
	NonNullable<ConfiguredProviderV1['persistReadRoot']>
>([Type.Ref('provider.persistence')], Type.Undefined(), 'async');

export const configuredProviderSchema = Type.Object(
	{
		settings: Type.Optional(sharedSettingsSchema),
		open: callable<ConfiguredProviderV1['open']>(
			[Type.Ref('provider.openRequest'), Type.Ref('provider.openContext')],
			Type.Ref('provider.backend'),
			'async'
		),
		copy: Type.Optional(configuredCopy),
		persistReadRoot: Type.Optional(configuredPersistence)
	},
	{ additionalProperties: false }
);

export const unavailableProviderDeclarationSchema = withKnownOwnFields(
	Type.Object({
		id: providerIdSchema,
		label: nonEmptyStringSchema,
		unavailable: providerUnavailabilitySchema
	})
);

export const hostOptionsSchema = Type.Object(
	{
		cleanup: Type.Optional(cleanupSelectionSchema),
		agentDirectory: Type.Optional(hostAbsolutePathSchema)
	},
	{ additionalProperties: false }
);
