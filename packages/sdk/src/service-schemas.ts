import path from 'node:path';

import type { TObject } from 'typebox';
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

// TypeBox counts own keys for compiled closed objects. Services can inherit methods.
function withKnownOwnFields<Schema extends TObject>(shape: Schema) {
	return Type.Refine(shape, (value) =>
		Object.keys(value).every((key) => Object.hasOwn(shape.properties, key))
	);
}

export const brokerServiceSchema = withKnownOwnFields(
	Type.Object({
		acquire: callable<BrokerService['acquire']>(),
		negotiate: callable<BrokerService['negotiate']>(),
		resolveReviewSource: callable<BrokerService['resolveReviewSource']>(),
		status: callable<BrokerService['status']>(),
		providers: callable<BrokerService['providers']>()
	})
);

const providerIdSchema = Type.Refine(
	nonEmptyStringSchema,
	(value) => !builtinProviders.has(value)
);

export const providerDeclarationSchema = withKnownOwnFields(
	Type.Object({
		id: providerIdSchema,
		label: nonEmptyStringSchema,
		profiles: providerInfoSchema.properties.profiles,
		create: callable<AvailableSandboxProvider<unknown>['create']>()
	})
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
		agentDirectory: Type.Optional(
			Type.Refine(nonEmptyStringSchema, (directory) =>
				path.isAbsolute(directory)
			)
		)
	},
	{ additionalProperties: false }
);
