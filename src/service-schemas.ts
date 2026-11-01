import { Type } from 'typebox';

import type { SandboxProvider } from './contracts.js';
import type {
	BrokerServiceV1,
	DiscoveryRequestV1,
	ProviderServiceV1
} from './protocol.js';
import {
	callable,
	denseArray,
	nonEmptyStringSchema,
	positiveIntegerSchema,
	providerInfoSchema,
	recordSchema
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

export const providerServiceSchema = Type.Object({
	...providerInfoSchema.properties,
	configure: callable<ProviderServiceV1['configure']>()
});

export const brokerServiceSchema = Type.Object({
	id: nonEmptyStringSchema,
	acquire: callable<BrokerServiceV1['acquire']>(),
	close: callable<BrokerServiceV1['close']>(),
	status: callable<BrokerServiceV1['status']>(),
	providers: callable<BrokerServiceV1['providers']>()
});

export const providerDeclarationSchema = Type.Object({
	...providerInfoSchema.properties,
	id: Type.Refine(nonEmptyStringSchema, (value) => value !== 'passthrough'),
	protocolVersion: Type.Literal(1),
	validateConfig: callable<SandboxProvider<unknown>['validateConfig']>(),
	open: callable<SandboxProvider<unknown>['open']>()
});

export const shellIntegrationSchema = Type.Object({
	kind: Type.Literal('pi-byos.shell-integration'),
	discoveryVersion: Type.Literal(1)
});
