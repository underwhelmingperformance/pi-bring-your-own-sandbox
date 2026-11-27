import { Type } from 'typebox';

import { backendSchema, workspaceSchema } from './backend-schemas.js';
import type { SandboxContext } from './contracts.js';
import { closeReportSchema, errorSchema } from './error-schema.js';
import {
	accessPolicySchema as policySchema,
	pathGrantsSchema,
	profileSchema,
	providerInfoSchema
} from './policy-model.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { protocolEnvelopeSchema } from './protocol-envelope.js';
import {
	acquireOptionsSchema,
	findRequestSchema,
	grepRequestSchema,
	operationOptionsSchema,
	processOptionsSchema,
	processRequestSchema,
	providerConfigSchema,
	writeOptionsSchema
} from './request-schemas.js';
import {
	fileStatSchema,
	processOutcomeSchema,
	processOutputSchema
} from './result-schemas.js';
import { reviewIdentityReplySchema } from './review-identities.js';
import {
	callable,
	capabilitiesSchema,
	nonEmptyStringSchema,
	recoverySchema
} from './schemas.js';
import {
	brokerServiceSchema,
	hostOptionsSchema,
	providerServiceSchema,
	runtimeSettingsSchema
} from './service-schemas.js';

const buildRequest = Type.Object(
	{ type: Type.Literal('get-builds') },
	{ additionalProperties: false }
);

export const buildAdvertisement = Type.Object(
	{ type: Type.Literal('build'), candidateId: nonEmptyStringSchema },
	{ additionalProperties: false }
);

export type BrokerStarter = (context: SandboxContext) => Promise<void>;

export const startBrokerRequest = Type.Object(
	{
		type: Type.Literal('start-broker'),
		candidateId: nonEmptyStringSchema,
		receive:
			callable<(identity: ProtocolIdentity, start: BrokerStarter) => void>()
	},
	{ additionalProperties: false }
);

const brokerRequest = Type.Object(
	{ type: Type.Literal('get-broker') },
	{ additionalProperties: false }
);

export const brokerReply = Type.Object(
	{
		type: Type.Literal('broker'),
		id: nonEmptyStringSchema,
		service: brokerServiceSchema
	},
	{ additionalProperties: false }
);

const providerRequest = Type.Object(
	{ type: Type.Literal('get-providers') },
	{ additionalProperties: false }
);

export const providerAdvertisement = Type.Object(
	{
		type: Type.Literal('provider'),
		id: nonEmptyStringSchema,
		service: providerServiceSchema
	},
	{ additionalProperties: false }
);
export const findReviewRequest = Type.Object(
	{
		type: Type.Literal('find-source'),
		toolName: nonEmptyStringSchema,
		toolCallId: nonEmptyStringSchema,
		sessionId: nonEmptyStringSchema
	},
	{ additionalProperties: false }
);
export const sourceReply = reviewIdentityReplySchema;
export const configBindingSchema = Type.Object(
	{
		id: nonEmptyStringSchema,
		resolve: callable<import('./contracts.js').SandboxConfigResolver<unknown>>()
	},
	{ additionalProperties: false }
);
export const copyOptionsSchema = acquireOptionsSchema;

export const hostBindingSchema = Type.Object(
	{ id: nonEmptyStringSchema, options: hostOptionsSchema },
	{ additionalProperties: false }
);

const reviewAvailability = Type.Object(
	{ type: Type.Literal('available') },
	{ additionalProperties: false }
);
const shellIntegration = Type.Object(
	{ type: Type.Literal('shell-integration') },
	{ additionalProperties: false }
);

function message(type: string) {
	return Type.Object(
		{ type: Type.Literal(type) },
		{ additionalProperties: false }
	);
}

function runtimeService(type: string, service: import('typebox').TSchema) {
	return Type.Object(
		{
			type: Type.Literal(type),
			id: nonEmptyStringSchema,
			service
		},
		{ additionalProperties: false }
	);
}

const copyOrigin = Type.Union([
	Type.Object({ kind: Type.Literal('host') }),
	Type.Object({
		kind: Type.Literal('sandbox'),
		providerId: nonEmptyStringSchema,
		generationId: nonEmptyStringSchema,
		backendId: nonEmptyStringSchema
	})
]);

const providerOpenRequest = Type.Object({
	generationId: nonEmptyStringSchema,
	sessionId: nonEmptyStringSchema,
	hostWorkspace: nonEmptyStringSchema,
	profile: profileSchema,
	paths: Type.Optional(pathGrantsSchema)
});

const providerCopySource = Type.Union([
	Type.Object({ kind: Type.Literal('host') }),
	Type.Object({ kind: Type.Literal('backend'), backend: backendSchema })
]);

export const protocolSchemas = {
	envelope: protocolEnvelopeSchema,
	'incompatible-major': message('incompatible-major'),
	'incompatible-demand': message('unrepresentable-demand'),
	'unrepresentable-offer': Type.Object(
		{
			type: Type.Literal('unrepresentable-offer'),
			service: nonEmptyStringSchema
		},
		{ additionalProperties: false }
	),
	'runtime.get-builds': buildRequest,
	'runtime.build': buildAdvertisement,
	'runtime.start-broker': startBrokerRequest,
	'runtime.get-broker': brokerRequest,
	'runtime.broker': brokerReply,
	'runtime.get-settings': message('get-settings'),
	'runtime.settings': runtimeService('settings', runtimeSettingsSchema),
	'runtime.get-host-options': message('get-host-options'),
	'runtime.host-options': runtimeService('host-options', hostBindingSchema),
	'runtime.get-configuration-providers': message('get-configuration-providers'),
	'runtime.configuration-providers': runtimeService(
		'configuration-providers',
		configBindingSchema
	),
	'runtime.get-shell-integration': message('get-shell-integration'),
	'runtime.shell-integration': shellIntegration,
	'provider.get-providers': providerRequest,
	'provider.provider': providerAdvertisement,
	'provider.openRequest': providerOpenRequest,
	'provider.copyRequest': Type.Object({
		...providerOpenRequest.properties,
		source: providerCopySource
	}),
	'provider.configuration': providerConfigSchema,
	'review.get-availability': message('get-availability'),
	'review.available': reviewAvailability,
	'review.find-source': findReviewRequest,
	'review.source': sourceReply,
	'broker.acquireOptions': acquireOptionsSchema,
	'broker.copyOptions': copyOptionsSchema,
	'broker.copyOrigin': copyOrigin,
	'broker.providerInfo': providerInfoSchema,
	'sandbox.capabilities': capabilitiesSchema,
	'sandbox.policy': policySchema,
	'sandbox.workspace': workspaceSchema,
	'sandbox.recovery': recoverySchema,
	'sandbox.processRequest': processRequestSchema,
	'sandbox.processOptions': processOptionsSchema,
	'sandbox.processOutput': processOutputSchema,
	'sandbox.processOutcome': processOutcomeSchema,
	'sandbox.fileStat': fileStatSchema,
	'sandbox.operationOptions': operationOptionsSchema,
	'sandbox.writeOptions': writeOptionsSchema,
	'sandbox.findRequest': findRequestSchema,
	'sandbox.grepRequest': grepRequestSchema,
	'sandbox.closeReport': closeReportSchema,
	error: errorSchema
};
