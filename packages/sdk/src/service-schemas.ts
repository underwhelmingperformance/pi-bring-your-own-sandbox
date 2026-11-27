import { Type } from 'typebox';

import { builtinProviders } from './builtin-providers.js';
import { cleanupSelectionSchema } from './cleanup-budgets.js';
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

export const brokerServiceSchema = Type.Object({
	id: nonEmptyStringSchema,
	acquire: callable<BrokerService['acquire']>(),
	negotiate: callable<BrokerService['negotiate']>(),
	resolveReviewSource:
		Type.Optional(
			callable<NonNullable<BrokerService['resolveReviewSource']>>()
		),
	status: callable<BrokerService['status']>(),
	providers: callable<BrokerService['providers']>()
});

const providerIdSchema = Type.Refine(
	nonEmptyStringSchema,
	(value) => !builtinProviders.has(value)
);

export const providerDeclarationSchema = Type.Object(
	{
		id: providerIdSchema,
		label: nonEmptyStringSchema,
		profiles: providerInfoSchema.properties.profiles,
		create: callable<AvailableSandboxProvider<unknown>['create']>()
	},
	{ additionalProperties: false }
);

type Implementation = SandboxProviderImplementation<unknown>;

const copyImplementation = callable<NonNullable<Implementation['copy']>>();
const persistImplementation =
	callable<NonNullable<Implementation['persistReadRoot']>>();

export const providerImplementationSchema = Type.Object({
	configure: callable<Implementation['configure']>(),
	open: callable<Implementation['open']>(),
	copy: Type.Optional(copyImplementation),
	persistReadRoot: Type.Optional(persistImplementation)
});

const configuredCopy = callable<NonNullable<ConfiguredProviderV1['copy']>>();
const configuredPersistence =
	callable<NonNullable<ConfiguredProviderV1['persistReadRoot']>>();

export const configuredProviderSchema = Type.Object(
	{
		settings: Type.Optional(sharedSettingsSchema),
		open: callable<ConfiguredProviderV1['open']>(),
		copy: Type.Optional(configuredCopy),
		persistReadRoot: Type.Optional(configuredPersistence)
	},
	{ additionalProperties: false }
);

export const unavailableProviderDeclarationSchema = Type.Object(
	{
		id: providerIdSchema,
		label: nonEmptyStringSchema,
		unavailable: providerUnavailabilitySchema
	},
	{ additionalProperties: false }
);

export const hostOptionsSchema = Type.Object(
	{
		cleanup: Type.Optional(cleanupSelectionSchema)
	},
	{ additionalProperties: false }
);
