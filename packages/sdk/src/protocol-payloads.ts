import { Type } from 'typebox';

import { backendSchema, workspaceSchema } from './backend-schemas.js';
import type { SandboxContext, ShellReviewSource } from './contracts.js';
import { closeReportSchema, errorSchema } from './error-schema.js';
import {
	destinationDescriptionSchema,
	escalationRequestSchema
} from './escalation-ledger.js';
import {
	accessPolicySchema as policySchema,
	pathGrantsSchema,
	profileSchema,
	providerInfoSchema
} from './policy-model.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	protocolEnvelopeSchema,
	protocolIdentitySchema
} from './protocol-envelope.js';
import {
	acquireOptionsSchema,
	findRequestSchema,
	grepRequestSchema,
	operationOptionsSchema,
	processOptionsSchema,
	processRequestSchema,
	readOptionsSchema
} from './request-schemas.js';
import {
	fileStatSchema,
	processOutcomeSchema,
	processOutputSchema
} from './result-schemas.js';
import { reviewIdentityReplySchema } from './review-identities.js';
import type { RuntimeParticipant } from './runtime-participant.js';
import {
	callable,
	hostUserDataRootsSchema,
	nonEmptyStringSchema,
	recoverySchema,
	signalSchema
} from './schemas.js';
import {
	brokerServiceSchema,
	configuredProviderSchema
} from './service-schemas.js';

const buildRequest = Type.Object(
	{ type: Type.Literal('get-builds') },
	{ additionalProperties: false }
);

export const buildAdvertisement = Type.Object(
	{ type: Type.Literal('build'), candidateId: nonEmptyStringSchema },
	{ additionalProperties: false }
);

export interface RuntimeCandidate {
	readonly identity: ProtocolIdentity;
	readonly candidateId: string;
}

export type BrokerStarter = (
	context: SandboxContext,
	candidates: readonly RuntimeCandidate[]
) => Promise<void>;

export interface BrokerPin extends RuntimeCandidate {
	readonly brokerId: string;
}

export const startBrokerRequest = Type.Object(
	{
		type: Type.Literal('start-broker'),
		candidateId: nonEmptyStringSchema,
		owner: protocolIdentitySchema,
		sessionId: nonEmptyStringSchema,
		receive:
			callable<(identity: ProtocolIdentity, start: BrokerStarter) => void>()
	},
	{ additionalProperties: false }
);

export const connectRuntimeRequest = Type.Object(
	{
		type: Type.Literal('connect-runtime'),
		electionId: nonEmptyStringSchema,
		candidateId: nonEmptyStringSchema,
		ownerCandidateId: nonEmptyStringSchema,
		brokerId: nonEmptyStringSchema,
		sessionId: nonEmptyStringSchema,
		receive:
			callable<
				(identity: ProtocolIdentity, participant: RuntimeParticipant) => void
			>()
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
		candidateId: nonEmptyStringSchema,
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
		service: providerInfoSchema
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

const providerOpenRequest = Type.Object({
	generationId: nonEmptyStringSchema,
	sessionId: nonEmptyStringSchema,
	hostWorkspace: nonEmptyStringSchema,
	profile: profileSchema,
	paths: Type.Optional(pathGrantsSchema),
	hostUserDataRoots: Type.Optional(hostUserDataRootsSchema),
	credentialExclusions: Type.Optional(hostUserDataRootsSchema)
});

const providerCopySource = Type.Union([
	Type.Object({ kind: Type.Literal('host') }),
	Type.Object({ kind: Type.Literal('backend'), backend: backendSchema })
]);

const recordDecision =
	callable<NonNullable<ShellReviewSource['recordDecision']>>();

export const reviewSourceSchema = Type.Refine(
	Type.Object({
		destination: destinationDescriptionSchema,
		escalation: Type.Optional(escalationRequestSchema),
		signal: Type.Optional(signalSchema),
		recordDecision: Type.Optional(recordDecision),
		negotiateCopy: callable<ShellReviewSource['negotiateCopy']>(),
		copy: callable<ShellReviewSource['copy']>()
	}),
	({ escalation, signal, recordDecision }) =>
		(escalation !== undefined) === (signal !== undefined) &&
		(escalation !== undefined) === (recordDecision !== undefined)
);

export const protocolSchemas = {
	envelope: protocolEnvelopeSchema,
	'incompatible-major': message('incompatible-major'),
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
	'runtime.connect-runtime': connectRuntimeRequest,
	'runtime.get-broker': brokerRequest,
	'runtime.broker': brokerReply,
	'runtime.get-shell-integration': message('get-shell-integration'),
	'runtime.shell-integration': shellIntegration,
	'provider.get-providers': providerRequest,
	'provider.provider': providerAdvertisement,
	'provider.openRequest': providerOpenRequest,
	'provider.copyRequest': Type.Object({
		...providerOpenRequest.properties,
		source: providerCopySource
	}),
	'provider.configured': configuredProviderSchema,
	'review.get-availability': message('get-availability'),
	'review.available': reviewAvailability,
	'review.find-source': findReviewRequest,
	'review.source': sourceReply,
	'broker.reviewSource': reviewSourceSchema,
	'broker.acquireOptions': acquireOptionsSchema,
	'broker.providerInfo': providerInfoSchema,
	'sandbox.profile': profileSchema,
	'sandbox.policy': policySchema,
	'sandbox.workspace': workspaceSchema,
	'sandbox.recovery': recoverySchema,
	'sandbox.processRequest': processRequestSchema,
	'sandbox.processOptions': processOptionsSchema,
	'sandbox.processOutput': processOutputSchema,
	'sandbox.processOutcome': processOutcomeSchema,
	'sandbox.fileStat': fileStatSchema,
	'sandbox.operationOptions': operationOptionsSchema,
	'sandbox.readOptions': readOptionsSchema,
	'sandbox.findRequest': findRequestSchema,
	'sandbox.grepRequest': grepRequestSchema,
	'sandbox.closeReport': closeReportSchema,
	error: errorSchema
};
