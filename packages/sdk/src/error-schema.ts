import { Type } from 'typebox';

import type { SandboxCloseReport, SandboxErrorInfo } from './contracts.js';
import {
	accessPolicySchema,
	accessStateSchema,
	providerUnavailabilitySchema
} from './policy-model.js';
import {
	capabilitySchema,
	denseArray,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	processKindSchema,
	recoverySchema,
	shellSchema,
	terminationScopeSchema
} from './schemas.js';

export const operationSchema = Type.Union([
	Type.Literal('acquire'),
	Type.Literal('discover'),
	Type.Literal('configure'),
	Type.Literal('open'),
	Type.Literal('exec'),
	Type.Literal('readFile'),
	Type.Literal('writeFile'),
	Type.Literal('mkdir'),
	Type.Literal('access'),
	Type.Literal('stat'),
	Type.Literal('listDirectory'),
	Type.Literal('find'),
	Type.Literal('grep'),
	Type.Literal('dispose')
]);

const completionSchema = Type.Union([
	Type.Literal('not-started'),
	Type.Literal('confirmed'),
	Type.Literal('unknown')
]);
const reasonSchema = Type.Union([
	Type.Literal('caller'),
	Type.Literal('deadline'),
	Type.Literal('shutdown'),
	Type.Literal('output')
]);

export const ordinaryErrorNameSchema = Type.Union([
	Type.Literal('SandboxInitialisationError'),
	Type.Literal('DuplicateBrokerError'),
	Type.Literal('IncompatibleSandboxProtocolError'),
	Type.Literal('InvalidSandboxDeclarationError'),
	Type.Literal('InvalidSandboxConfigError'),
	Type.Literal('InvalidSandboxRequestError'),
	Type.Literal('ProviderNotFoundError'),
	Type.Literal('SandboxProviderUnavailableError'),
	Type.Literal('DuplicateProviderError'),
	Type.Literal('ConflictingSandboxConfigError'),
	Type.Literal('ConflictingSandboxProviderError'),
	Type.Literal('UnsupportedSandboxCapabilityError'),
	Type.Literal('UnsupportedSandboxPolicyError'),
	Type.Literal('SandboxStartupError'),
	Type.Literal('StaleSandboxHandleError'),
	Type.Literal('SandboxSessionClosingError'),
	Type.Literal('SandboxPermissionDeniedError'),
	Type.Literal('SandboxPathNotFoundError'),
	Type.Literal('SandboxOperationError')
]);

const refusalReason = Type.Union([
	Type.Literal('limit'),
	Type.Literal('profile')
]);
const detailKind = Type.Literal('capability');
const needDetails = [
	Type.Object({
		kind: detailKind,
		field: Type.Literal('capabilities'),
		value: capabilitySchema
	}),
	Type.Object({
		kind: detailKind,
		field: Type.Literal('processKinds'),
		value: processKindSchema
	}),
	Type.Object({
		kind: detailKind,
		field: Type.Literal('shells'),
		value: shellSchema
	}),
	Type.Object({
		kind: detailKind,
		field: Type.Literal('exitStatus'),
		value: Type.Literal('guaranteed')
	}),
	Type.Object({
		kind: detailKind,
		field: Type.Literal('terminationScope'),
		value: terminationScopeSchema
	})
] as const;

const pathAccess = Type.Union([Type.Literal('read'), Type.Literal('write')]);
const pathRefusalReason = Type.Union([
	Type.Literal('limit'),
	Type.Literal('profile'),
	Type.Literal('unreachable')
]);
const requestValue = Type.Union([Type.String(), Type.Boolean(), Type.Number()]);

export const errorDetailSchema = Type.Union([
	...needDetails,
	Type.Object({ kind: Type.Literal('copy-unavailable') }),
	Type.Object({
		kind: Type.Literal('read-limit'),
		maxBytes: nonNegativeIntegerSchema
	}),
	Type.Object({
		kind: Type.Literal('policy'),
		reason: Type.Literal('profile')
	}),
	Type.Object({
		kind: Type.Literal('access'),
		property: Type.KeyOf(accessPolicySchema),
		value: accessStateSchema,
		reason: refusalReason
	}),
	Type.Object({
		kind: Type.Literal('path'),
		access: pathAccess,
		path: nonEmptyStringSchema,
		reason: pathRefusalReason
	}),
	Type.Object({
		kind: Type.Literal('declaration'),
		field: nonEmptyStringSchema
	}),
	Type.Object({
		kind: Type.Literal('config'),
		field: nonEmptyStringSchema
	}),
	Type.Object({
		kind: Type.Literal('provider-unavailable'),
		reason: providerUnavailabilitySchema
	}),
	Type.Object({
		kind: Type.Literal('request'),
		field: nonEmptyStringSchema,
		value: Type.Optional(requestValue)
	})
]);

const errorContextSchema = Type.Object({
	message: Type.String(),
	extensionSource: Type.Optional(nonEmptyStringSchema),
	detail: Type.Optional(errorDetailSchema),
	operation: operationSchema,
	providerId: Type.Optional(nonEmptyStringSchema),
	backendId: Type.Optional(nonEmptyStringSchema),
	recovery: Type.Optional(recoverySchema)
});

const transportNames = Type.Union([
	Type.Literal('SandboxTransportError'),
	Type.Literal('UnconfirmedSandboxTerminationError')
]);
const cancellationReasons = Type.Union([
	Type.Literal('caller'),
	Type.Literal('shutdown')
]);

const closeReportReference = Type.Ref('CloseReport');
const errorVariantsSchema = Type.Union([
	Type.Object({ name: ordinaryErrorNameSchema }),
	Type.Object({
		name: Type.Literal('SandboxCleanupError'),
		closeReport: Type.Optional(closeReportReference)
	}),
	Type.Object({
		name: transportNames,
		completion: Type.Literal('unknown'),
		reason: Type.Optional(reasonSchema)
	}),
	Type.Object({
		name: Type.Literal('SandboxCancelledError'),
		completion: completionSchema,
		reason: cancellationReasons
	}),
	Type.Object({
		name: Type.Literal('SandboxTimeoutError'),
		completion: completionSchema,
		reason: Type.Literal('deadline')
	}),
	Type.Object({
		name: Type.Literal('SandboxOutputCallbackError'),
		completion: completionSchema,
		reason: Type.Literal('output')
	})
]);

const errorShape = Type.Intersect([errorContextSchema, errorVariantsSchema]);

const closeReportShape = Type.Object({
	confirmed: Type.Boolean(),
	failures: denseArray(Type.Ref('SandboxError')),
	recoveries: denseArray(recoverySchema)
});
const definitions = { SandboxError: errorShape, CloseReport: closeReportShape };

export const errorSchema = Type.Unsafe<SandboxErrorInfo>(
	Type.Cyclic(definitions, 'SandboxError')
);
export const closeReportSchema = Type.Unsafe<SandboxCloseReport>(
	Type.Cyclic(definitions, 'CloseReport')
);
