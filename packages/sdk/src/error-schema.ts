import { Type } from 'typebox';

import { nonEmptyStringSchema, recoverySchema } from './schemas.js';

export const operationSchema = Type.Enum([
	'acquire',
	'discover',
	'configure',
	'open',
	'exec',
	'readFile',
	'writeFile',
	'mkdir',
	'access',
	'stat',
	'listDirectory',
	'updateText',
	'find',
	'grep',
	'dispose'
]);

const completionSchema = Type.Enum([
	'not-started',
	'confirmed',
	'unknown',
	'not-guaranteed'
]);
const reasonSchema = Type.Enum(['caller', 'deadline', 'shutdown', 'output']);

export const ordinaryErrorNameSchema = Type.Enum([
	'SandboxInitialisationError',
	'DuplicateBrokerError',
	'IncompatibleSandboxProtocolError',
	'InvalidSandboxDeclarationError',
	'InvalidSandboxConfigError',
	'InvalidSandboxRequestError',
	'ProviderNotFoundError',
	'DuplicateProviderError',
	'UnsupportedSandboxCapabilityError',
	'UnsupportedSandboxPolicyError',
	'SandboxStartupError',
	'StaleSandboxHandleError',
	'SandboxSessionClosingError',
	'SandboxPermissionDeniedError',
	'SandboxPathNotFoundError',
	'SandboxOperationError',
	'SandboxCleanupError'
]);

const errorContextSchema = Type.Object({
	sandboxErrorVersion: Type.Literal(1),
	message: Type.String(),
	operation: operationSchema,
	configurationSource: Type.Optional(Type.Literal('personal')),
	providerId: Type.Optional(nonEmptyStringSchema),
	backendId: Type.Optional(nonEmptyStringSchema),
	recovery: Type.Optional(recoverySchema)
});

const errorVariantsSchema = Type.Union([
	Type.Object({ name: ordinaryErrorNameSchema }),
	Type.Object({
		name: Type.Enum([
			'SandboxTransportError',
			'UnconfirmedSandboxTerminationError'
		]),
		completion: Type.Literal('unknown'),
		reason: Type.Optional(reasonSchema)
	}),
	Type.Object({
		name: Type.Literal('SandboxCancelledError'),
		completion: completionSchema,
		reason: Type.Enum(['caller', 'shutdown'])
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
