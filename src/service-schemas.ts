import { Type } from 'typebox';

import type {
	ApprovalPolicy,
	OutsideSandboxProvider
} from './approval-contracts.js';
import { absolutePathSchema } from './backend-schemas.js';
import { builtinProviders } from './builtin-providers.js';
import { cleanupSelectionSchema } from './cleanup-budgets.js';
import type { SandboxProvider } from './contracts.js';
import type {
	ApprovalPolicyServiceV1,
	ApprovalServiceV1,
	ConfiguredApprovalPolicyV1
} from './execution-approval.js';
import type { OutsideServiceV1 } from './outside-execution.js';
import type { OutsideProviderServiceV1 } from './outside-execution.js';
import type {
	BrokerServiceV1,
	DiscoveryRequestV1,
	ProviderServiceV1
} from './protocol.js';
import type { RuntimeSettingsV1 } from './runtime-settings.js';
import {
	callable,
	capabilitiesSchema,
	denseArray,
	nonEmptyStringSchema,
	policySchema,
	positiveIntegerSchema,
	providerInfoSchema,
	recordSchema,
	signalSchema
} from './schemas.js';

export const discoveryRequestSchema = Type.Object({
	kind: Type.Literal('pi-byos.discover'),
	discoveryVersion: Type.Literal(1),
	reply: callable<DiscoveryRequestV1['reply']>()
});

export const advertisementSchema = Type.Object({
	kind: Type.Enum(['pi-byos.broker', 'pi-byos.provider']),
	discoveryVersion: Type.Literal(1),
	id: nonEmptyStringSchema,
	serviceVersions: denseArray(positiveIntegerSchema, {
		minItems: 1,
		uniqueItems: true
	}),
	service: recordSchema
});

export const outsideProviderSchema = Type.Object({
	label: nonEmptyStringSchema,
	capabilities: capabilitiesSchema,
	policy: policySchema,
	configure: callable<OutsideProviderServiceV1['configure']>()
});

const outsideDeclarationSchema = Type.Object({
	label: nonEmptyStringSchema,
	capabilities: capabilitiesSchema,
	policy: policySchema,
	open: callable<OutsideSandboxProvider<unknown>['open']>()
});

export const providerServiceSchema = Type.Intersect([
	providerInfoSchema,
	Type.Object({
		configure: callable<ProviderServiceV1['configure']>(),
		outsideSandbox: Type.Optional(outsideProviderSchema)
	})
]);

export const brokerServiceSchema = Type.Object({
	id: nonEmptyStringSchema,
	acquire: callable<BrokerServiceV1['acquire']>(),
	negotiate: callable<BrokerServiceV1['negotiate']>(),
	close: callable<BrokerServiceV1['close']>(),
	status: callable<BrokerServiceV1['status']>(),
	providers: callable<BrokerServiceV1['providers']>()
});

export const providerDeclarationSchema = Type.Intersect([
	providerInfoSchema,
	Type.Object({
		id: Type.Refine(
			nonEmptyStringSchema,
			(value) => !builtinProviders.has(value)
		),
		protocolVersion: Type.Literal(1),
		validateConfig: callable<SandboxProvider<unknown>['validateConfig']>(),
		open: callable<SandboxProvider<unknown>['open']>(),
		outsideSandbox: Type.Optional(outsideDeclarationSchema)
	})
]);

export const approvalPolicyDeclarationSchema = Type.Object({
	id: Type.Refine(
		nonEmptyStringSchema,
		(value) => !['user', 'always', 'never'].includes(value)
	),
	label: nonEmptyStringSchema,
	protocolVersion: Type.Literal(1),
	validateConfig: callable<ApprovalPolicy<unknown>['validateConfig']>(),
	decide: callable<ApprovalPolicy<unknown>['decide']>()
});

export const shellIntegrationSchema = Type.Object({
	kind: Type.Literal('pi-byos.shell-integration'),
	discoveryVersion: Type.Literal(1)
});

export const extensionServiceAdvertisementSchema = Type.Object({
	kind: Type.Literal('pi-byos.service'),
	discoveryVersion: Type.Literal(1),
	id: nonEmptyStringSchema,
	serviceVersions: denseArray(positiveIntegerSchema, {
		minItems: 1,
		uniqueItems: true
	}),
	service: recordSchema
});
export const configuredApprovalPolicySchema = Type.Object({
	decide: callable<ConfiguredApprovalPolicyV1['decide']>()
});
export const approvalPolicyServiceSchema = Type.Object({
	id: nonEmptyStringSchema,
	label: nonEmptyStringSchema,
	configure: callable<ApprovalPolicyServiceV1['configure']>()
});
export const approvalServiceSchema = Type.Object({
	id: nonEmptyStringSchema,
	close: callable<ApprovalServiceV1['close']>(),
	request: callable<ApprovalServiceV1['request']>(),
	policies: callable<ApprovalServiceV1['policies']>()
});

const normalExecutorSchema = Type.Object({
	...outsideDeclarationSchema.properties,
	open: callable<OutsideSandboxProvider<undefined>['open']>()
});

export const runtimeSettingsSchema = Type.Object({
	id: nonEmptyStringSchema,
	lifetime: signalSchema,
	close: callable<RuntimeSettingsV1['close']>(),
	read: callable<RuntimeSettingsV1['read']>(),
	normalExecutor: Type.Optional(normalExecutorSchema)
});

export const outsideServiceSchema = Type.Object({
	status: callable<OutsideServiceV1['status']>(),
	id: nonEmptyStringSchema,
	lifetime: signalSchema,
	close: callable<OutsideServiceV1['close']>(),
	track: callable<OutsideServiceV1['track']>(),
	assertLive: callable<OutsideServiceV1['assertLive']>(),
	acquire: callable<OutsideServiceV1['acquire']>()
});

export const hostOptionsSchema = Type.Object(
	{
		agentDirectory: absolutePathSchema(
			process.platform === 'win32' ? 'win32' : 'posix'
		),
		normalExecutor: Type.Optional(normalExecutorSchema),
		cleanup: Type.Optional(cleanupSelectionSchema)
	},
	{ additionalProperties: false }
);
