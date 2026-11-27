import { Type } from 'typebox';

import { backendSchema, workspaceSchema } from './backend-schemas.js';
import { brokerStatusSchema } from './broker-status-schema.js';
import {
	directoryResultSchema,
	findResults,
	grepResults,
	negotiationSchema,
	ownedCopySchema,
	processResultSchema,
	sandboxHandleSchema
} from './consumer-wire-schemas.js';
import {
	backendProcessContextSchema,
	readRootPersistenceSchema,
	sandboxConfigContextSchema,
	sandboxContextSchema,
	sandboxOpenContextSchema,
	sandboxOperationContextSchema
} from './context-schemas.js';
import type { SandboxContext, ShellReviewSource } from './contracts.js';
import { closeReportSchema, errorSchema } from './error-schema.js';
import {
	destinationDescriptionSchema,
	escalationRequestSchema,
	ledgerEntrySchema
} from './escalation-ledger.js';
import {
	accessPolicySchema as policySchema,
	profileSchema,
	providerInfoSchema
} from './policy-model.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	protocolEnvelopeSchema,
	protocolIdentitySchema
} from './protocol-envelope.js';
import {
	providerCopyRequestSchema,
	providerOpenRequestSchema
} from './provider-wire-schemas.js';
import {
	accessModeSchema,
	acquireOptionsSchema,
	findRequestSchema,
	grepRequestSchema,
	operationOptionsSchema,
	processOptionsSchema,
	processRequestSchema,
	providerConfigSchema,
	readOptionsSchema,
	requirementsSchema,
	sharedSettingsSchema
} from './request-schemas.js';
import {
	fileStatSchema,
	processOutcomeSchema,
	processOutputSchema
} from './result-schemas.js';
import {
	reviewIdentityReplySchema,
	reviewQuerySchema
} from './review-identities.js';
import type { RuntimeParticipant } from './runtime-participant.js';
import {
	runtimeParticipantSchema,
	shellDispatchSchema,
	shellSettingsSchema
} from './runtime-wire-schemas.js';
import {
	callable,
	denseArray,
	nonEmptyStringSchema,
	recoverySchema,
	signalSchema
} from './schemas.js';
import {
	brokerServiceSchema,
	configuredProviderSchema,
	providerDeclarationSchema,
	providerImplementationSchema,
	unavailableProviderDeclarationSchema
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

const startBroker = callable<BrokerStarter>(
	[Type.Ref('runtime.context'), Type.Ref('runtime.candidates')],
	Type.Undefined(),
	'async'
);

export const startBrokerRequest = Type.Object(
	{
		type: Type.Literal('start-broker'),
		candidateId: nonEmptyStringSchema,
		owner: protocolIdentitySchema,
		sessionId: nonEmptyStringSchema,
		receive: callable<
			(identity: ProtocolIdentity, start: BrokerStarter) => void
		>([protocolIdentitySchema, startBroker], Type.Undefined())
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
		receive: callable<
			(identity: ProtocolIdentity, participant: RuntimeParticipant) => void
		>(
			[protocolIdentitySchema, Type.Ref('runtime.participant')],
			Type.Undefined()
		)
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

const recordDecision = callable<
	NonNullable<ShellReviewSource['recordDecision']>
>(
	[Type.Union([Type.Literal('allow'), Type.Literal('deny')])],
	Type.Undefined()
);

const reviewRequirements = Type.Optional(Type.Ref('broker.requirements'));
const reviewOptions = Type.Optional(Type.Ref('broker.acquireOptions'));
const reviewSourceShape = Type.Object({
	destination: destinationDescriptionSchema,
	escalation: Type.Optional(escalationRequestSchema),
	signal: Type.Optional(signalSchema),
	recordDecision: Type.Optional(recordDecision),
	negotiateCopy: callable<ShellReviewSource['negotiateCopy']>(
		[reviewRequirements],
		Type.Ref('sandbox.negotiation'),
		'async'
	),
	copy: callable<ShellReviewSource['copy']>(
		[reviewOptions],
		Type.Ref('sandbox.ownedCopy'),
		'async'
	)
});

export const reviewSourceSchema = Type.Refine(
	reviewSourceShape,
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
	'runtime.candidates': denseArray(
		Type.Object({
			identity: protocolIdentitySchema,
			candidateId: nonEmptyStringSchema
		})
	),
	'runtime.participant': runtimeParticipantSchema,
	'runtime.shellSettings': shellSettingsSchema,
	'runtime.shellDispatch': shellDispatchSchema,
	'runtime.context': sandboxContextSchema,
	'runtime.connect-runtime': connectRuntimeRequest,
	'runtime.get-broker': brokerRequest,
	'runtime.broker': brokerReply,
	'runtime.get-shell-integration': message('get-shell-integration'),
	'runtime.shell-integration': shellIntegration,
	'provider.get-providers': providerRequest,
	'provider.provider': providerAdvertisement,
	'provider.openRequest': providerOpenRequestSchema,
	'provider.copyRequest': providerCopyRequestSchema,
	'provider.localOpenRequest': Type.Object({
		...providerOpenRequestSchema.properties,
		configuration: Type.Unknown()
	}),
	'provider.localCopyRequest': Type.Object({
		...providerCopyRequestSchema.properties,
		configuration: Type.Unknown()
	}),
	'provider.localConfiguration': providerConfigSchema,
	'provider.sharedSettings': sharedSettingsSchema,
	'provider.declaration': Type.Union([
		providerDeclarationSchema,
		unavailableProviderDeclarationSchema
	]),
	'provider.implementation': providerImplementationSchema,
	'provider.configContext': sandboxConfigContextSchema,
	'provider.openContext': sandboxOpenContextSchema,
	'provider.operationContext': sandboxOperationContextSchema,
	'provider.processContext': backendProcessContextSchema,
	'provider.persistence': readRootPersistenceSchema,
	'provider.backend': backendSchema,
	'provider.configured': configuredProviderSchema,
	'review.get-availability': message('get-availability'),
	'review.available': reviewAvailability,
	'review.find-source': findReviewRequest,
	'review.source': sourceReply,
	'review.query': reviewQuerySchema,
	'broker.reviewSource': reviewSourceSchema,
	'broker.acquireOptions': acquireOptionsSchema,
	'broker.requirements': requirementsSchema,
	'broker.status': brokerStatusSchema,
	'broker.providerInfo': providerInfoSchema,
	'sandbox.signal': signalSchema,
	'sandbox.handle': sandboxHandleSchema,
	'sandbox.ownedCopy': ownedCopySchema,
	'sandbox.negotiation': negotiationSchema,
	'sandbox.processResult': processResultSchema,
	'sandbox.directoryEntries': directoryResultSchema,
	'sandbox.findResult': findResults,
	'sandbox.grepResult': grepResults,
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
	'sandbox.accessMode': accessModeSchema,
	'sandbox.readOptions': readOptionsSchema,
	'sandbox.findRequest': findRequestSchema,
	'sandbox.grepRequest': grepRequestSchema,
	'sandbox.closeReport': closeReportSchema,
	'ledger.entry': ledgerEntrySchema,
	error: errorSchema
};
