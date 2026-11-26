import { Type } from 'typebox';

import { nonEmptyStringSchema, recoverySchema } from './schemas.js';

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
	Type.Literal('updateText'),
	Type.Literal('find'),
	Type.Literal('grep'),
	Type.Literal('dispose')
]);

const completionSchema = Type.Union([
	Type.Literal('not-started'),
	Type.Literal('confirmed'),
	Type.Literal('unknown'),
	Type.Literal('not-guaranteed')
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
	Type.Literal('DuplicateProviderError'),
	Type.Literal('ConflictingSandboxConfigError'),
	Type.Literal('ConflictingSandboxProviderError'),
	Type.Literal('SandboxProviderRequiredError'),
	Type.Literal('SandboxProviderMismatchError'),
	Type.Literal('UnsupportedSandboxCapabilityError'),
	Type.Literal('UnsupportedSandboxPolicyError'),
	Type.Literal('SandboxStartupError'),
	Type.Literal('StaleSandboxHandleError'),
	Type.Literal('SandboxSessionClosingError'),
	Type.Literal('SandboxPermissionDeniedError'),
	Type.Literal('SandboxPathNotFoundError'),
	Type.Literal('SandboxOperationError'),
	Type.Literal('SandboxCleanupError')
]);

const errorContextSchema = Type.Object({
	message: Type.String(),
	operation: operationSchema,
	configurationSource: Type.Optional(Type.Literal('extension')),
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

const errorVariantsSchema = Type.Union([
	Type.Object({ name: ordinaryErrorNameSchema }),
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

export const errorSchema = Type.Refine(
	Type.Intersect([errorContextSchema, errorVariantsSchema]),
	(error) =>
		!('completion' in error && error.completion === 'not-guaranteed') ||
		error.operation === 'exec'
);
