import { Type } from 'typebox';

import { builtinProviders } from './builtin-providers.js';
import { cleanupSelectionSchema } from './cleanup-budgets.js';
import type { SandboxProvider } from './contracts.js';
import { providerInfoSchema } from './policy-model.js';
import type { BrokerService } from './protocol.js';
import { callable, nonEmptyStringSchema } from './schemas.js';

export const brokerServiceSchema = Type.Object({
	copy: callable<BrokerService['copy']>(),
	id: nonEmptyStringSchema,
	acquire: callable<BrokerService['acquire']>(),
	negotiate: callable<BrokerService['negotiate']>(),
	planEscalation:
		Type.Optional(callable<NonNullable<BrokerService['planEscalation']>>()),
	prepareReview:
		Type.Optional(callable<NonNullable<BrokerService['prepareReview']>>()),
	resolveReviewSource:
		Type.Optional(
			callable<NonNullable<BrokerService['resolveReviewSource']>>()
		),
	close: callable<BrokerService['close']>(),
	status: callable<BrokerService['status']>(),
	providers: callable<BrokerService['providers']>()
});

const copier = callable<NonNullable<SandboxProvider<unknown>['copy']>>();

const providerIdSchema = Type.Refine(
	nonEmptyStringSchema,
	(value) => !builtinProviders.has(value)
);
const providerMethodsSchema = Type.Object({
	id: providerIdSchema,
	validateConfig: callable<SandboxProvider<unknown>['validateConfig']>(),
	open: callable<SandboxProvider<unknown>['open']>(),
	copy: Type.Optional(copier)
});

export const providerDeclarationSchema = Type.Refine(
	Type.Intersect([providerInfoSchema, providerMethodsSchema]),
	(provider) =>
		provider.profiles.copy.length > 0 === (provider.copy !== undefined)
);

export const hostOptionsSchema = Type.Object(
	{
		cleanup: Type.Optional(cleanupSelectionSchema)
	},
	{ additionalProperties: false }
);
