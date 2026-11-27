import path from 'node:path';

import { Type } from 'typebox';

import { cleanupBudgetsSchema } from './cleanup-budgets.js';
import type {
	BackendProcessContext,
	SandboxCleanupContext,
	SandboxContext,
	SandboxOpenContext,
	SandboxOperationContext,
	SandboxReadRootPersistence
} from './contracts.js';
import {
	callable,
	denseArray,
	nonEmptyStringSchema,
	recoverySchema,
	signalSchema,
	targetPathSchema
} from './schemas.js';

const milliseconds = Type.Number({ minimum: 0, maximum: Number.MAX_VALUE });
const optionalMilliseconds = Type.Union([milliseconds, Type.Undefined()]);
const noResult = Type.Undefined();

export const sandboxContextSchema = Type.Object({
	cwd: targetPathSchema,
	sessionManager: Type.Object({
		getSessionId: callable<SandboxContext['sessionManager']['getSessionId']>(
			[],
			nonEmptyStringSchema
		)
	})
});

const sandboxCleanupContextSchema = Type.Object({
	deadline: optionalMilliseconds,
	remainingMs: callable<SandboxCleanupContext['remainingMs']>(
		[],
		optionalMilliseconds
	)
});

export const sandboxOperationContextSchema = Type.Object({
	operationId: nonEmptyStringSchema,
	signal: signalSchema,
	deadline: milliseconds,
	remainingMs: callable<SandboxOperationContext['remainingMs']>(
		[],
		milliseconds
	),
	reportWarning: callable<SandboxOperationContext['reportWarning']>(
		[Type.String({ minLength: 1, maxLength: 2048 })],
		noResult
	),
	cleanup: sandboxCleanupContextSchema,
	cleanupBudgets: Type.Optional(cleanupBudgetsSchema)
});

export const sandboxOpenContextSchema = Type.Object({
	...sandboxOperationContextSchema.properties,
	reportRecovery: callable<SandboxOpenContext['reportRecovery']>(
		[recoverySchema],
		noResult
	),
	confirmCleanup: callable<SandboxOpenContext['confirmCleanup']>([], noResult)
});

export const backendProcessContextSchema = Type.Object({
	...sandboxOperationContextSchema.properties,
	onOutput: callable<BackendProcessContext['onOutput']>(
		[Type.Ref('sandbox.processOutput')],
		noResult
	)
});

export const hostAbsolutePathSchema = Type.Refine(targetPathSchema, (value) =>
	path.isAbsolute(value)
);

export const sandboxConfigContextSchema = Type.Object({
	...sandboxOperationContextSchema.properties,
	pi: sandboxContextSchema,
	agentDirectory: hostAbsolutePathSchema
});

const validateSettings = callable<
	Parameters<SandboxReadRootPersistence['updateSettings']>[1]
>([Type.Unknown()], Type.Boolean());

export const readRootPersistenceSchema = Type.Object({
	paths: denseArray(hostAbsolutePathSchema, { uniqueItems: true }),
	updateSettings: callable<SandboxReadRootPersistence['updateSettings']>(
		[targetPathSchema, validateSettings],
		noResult,
		'async'
	)
});
