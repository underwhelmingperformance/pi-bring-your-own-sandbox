import { expect, expectTypeOf, it } from 'vitest';

import type { SandboxErrorInfo } from './api.js';
import {
	DuplicateBrokerError,
	DuplicateProviderError,
	IncompatibleSandboxProtocolError,
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	isSandboxError,
	ProviderNotFoundError,
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxError,
	SandboxInitialisationError,
	SandboxOperationError,
	SandboxOutputCallbackError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxStartupError,
	SandboxTimeoutError,
	SandboxTransportError,
	StaleSandboxHandleError,
	UnconfirmedSandboxTerminationError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './api.js';
import { rehydrateSandboxError } from './errors.js';

it('requires typed context for each concrete error', () => {
	expectTypeOf<
		ProviderNotFoundError['name']
	>().toEqualTypeOf<'ProviderNotFoundError'>();
	expectTypeOf<SandboxTimeoutError['reason']>().toEqualTypeOf<'deadline'>();
	expectTypeOf<
		SandboxTransportError['completion']
	>().toEqualTypeOf<'unknown'>();
	expectTypeOf<string>().not.toExtend<
		ConstructorParameters<typeof ProviderNotFoundError>[0]
	>();
	expectTypeOf<{ operation: string }>().not.toExtend<
		ConstructorParameters<typeof ProviderNotFoundError>[0]
	>();
	expectTypeOf<{
		operation: 'exec';
		reason: string;
		completion: 'confirmed';
	}>().not.toExtend<ConstructorParameters<typeof SandboxCancelledError>[0]>();
});

it('narrows errors structurally by their concrete name', () => {
	const error: unknown = new SandboxTimeoutError({
		operation: 'exec',
		completion: 'confirmed'
	});
	if (!isSandboxError(error, SandboxTimeoutError)) {
		throw new TypeError('The timeout error must pass its structural guard.');
	}
	expectTypeOf<typeof error.reason>().toEqualTypeOf<'deadline'>();
	expect(isSandboxError(error, SandboxCancelledError)).toBe(false);
	const serialised = JSON.stringify(error);
	const metadata: unknown = JSON.parse(serialised);
	expect(metadata).toStrictEqual({
		sandboxErrorVersion: 1,
		name: 'SandboxTimeoutError',
		operation: 'exec',
		reason: 'deadline',
		completion: 'confirmed'
	});
});

it('copies recovery metadata and excludes the diagnostic cause from serialisation', () => {
	const recovery = {
		kind: 'allocation',
		id: 'original',
		instructions: 'Remove the test resource.',
		lease: 'test-lease'
	} as const;
	const cause = new Error('private provider detail');
	const error = new SandboxCleanupError(
		{ operation: 'dispose', recovery },
		{ cause }
	);
	expect({
		recovery: error.recovery,
		frozen: Object.isFrozen(error.recovery),
		distinct: error.recovery !== recovery,
		cause: error.cause
	}).toStrictEqual({ recovery, frozen: true, distinct: true, cause });
	expect(JSON.stringify(error)).not.toContain('private provider detail');
});

it.each([
	{
		name: 'SandboxCancelledError',
		reason: 'caller',
		completion: 'not-started'
	},
	{
		name: 'SandboxCancelledError',
		reason: 'shutdown',
		completion: 'confirmed'
	},
	{ name: 'SandboxTimeoutError', reason: 'deadline', completion: 'unknown' },
	{
		name: 'SandboxOutputCallbackError',
		reason: 'output',
		completion: 'confirmed'
	},
	{ name: 'SandboxTransportError', completion: 'unknown' },
	{
		name: 'UnconfirmedSandboxTerminationError',
		reason: 'caller',
		completion: 'unknown'
	}
])('recognises structural errors from an independent SDK: %j', (details) => {
	expect(
		isSandboxError({
			sandboxErrorVersion: 1,
			message: 'Independent SDK failure',
			operation: 'exec',
			providerId: 'fixture',
			...details,
			futureMetadata: true
		})
	).toBe(true);
});

it.each([
	{
		name: 'SandboxTimeoutError',
		reason: 'deadline',
		completion: 'confirmed',
		providerId: 3
	},
	{ name: 'SandboxTimeoutError', reason: 'caller', completion: 'confirmed' },
	{
		name: 'SandboxCancelledError',
		reason: 'deadline',
		completion: 'confirmed'
	},
	{ name: 'SandboxCancelledError', reason: 'caller' },
	{ name: 'SandboxTransportError', completion: 'confirmed' },
	{ name: 'FutureUnknownError' }
])('rejects malformed structural errors: %j', (details) => {
	expect(
		isSandboxError({
			sandboxErrorVersion: 1,
			message: 'Malformed error',
			operation: 'exec',
			...details
		})
	).toBe(false);
});

it.each([
	undefined,
	new Error('ordinary'),
	{
		sandboxErrorVersion: 2,
		name: 'SandboxOperationError',
		message: 'Future protocol',
		operation: 'exec'
	},
	{
		sandboxErrorVersion: 1,
		name: 'SandboxOperationError',
		message: 'Invalid operation',
		operation: 'future'
	}
])('rejects values without a supported versioned error: %j', (value) => {
	expect(isSandboxError(value)).toBe(false);
});

const cases = [
	{
		name: 'SandboxInitialisationError',
		create: (cause: unknown) =>
			new SandboxInitialisationError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'DuplicateBrokerError',
		create: (cause: unknown) =>
			new DuplicateBrokerError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'IncompatibleSandboxProtocolError',
		create: (cause: unknown) =>
			new IncompatibleSandboxProtocolError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'InvalidSandboxDeclarationError',
		create: (cause: unknown) =>
			new InvalidSandboxDeclarationError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'InvalidSandboxConfigError',
		create: (cause: unknown) =>
			new InvalidSandboxConfigError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'InvalidSandboxRequestError',
		create: (cause: unknown) =>
			new InvalidSandboxRequestError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'ProviderNotFoundError',
		create: (cause: unknown) =>
			new ProviderNotFoundError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'DuplicateProviderError',
		create: (cause: unknown) =>
			new DuplicateProviderError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'UnsupportedSandboxCapabilityError',
		create: (cause: unknown) =>
			new UnsupportedSandboxCapabilityError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'UnsupportedSandboxPolicyError',
		create: (cause: unknown) =>
			new UnsupportedSandboxPolicyError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxStartupError',
		create: (cause: unknown) =>
			new SandboxStartupError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'StaleSandboxHandleError',
		create: (cause: unknown) =>
			new StaleSandboxHandleError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxSessionClosingError',
		create: (cause: unknown) =>
			new SandboxSessionClosingError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxPermissionDeniedError',
		create: (cause: unknown) =>
			new SandboxPermissionDeniedError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxPathNotFoundError',
		create: (cause: unknown) =>
			new SandboxPathNotFoundError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxOperationError',
		create: (cause: unknown) =>
			new SandboxOperationError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxCleanupError',
		create: (cause: unknown) =>
			new SandboxCleanupError(
				{ operation: 'exec', providerId: 'test.remote' },
				{ cause }
			)
	},
	{
		name: 'SandboxCancelledError',
		create: (cause: unknown) =>
			new SandboxCancelledError(
				{
					operation: 'exec',
					providerId: 'test.remote',
					reason: 'caller',
					completion: 'confirmed'
				},
				{ cause }
			)
	},
	{
		name: 'SandboxTimeoutError',
		create: (cause: unknown) =>
			new SandboxTimeoutError(
				{
					operation: 'exec',
					providerId: 'test.remote',
					completion: 'confirmed'
				},
				{ cause }
			)
	},
	{
		name: 'SandboxOutputCallbackError',
		create: (cause: unknown) =>
			new SandboxOutputCallbackError(
				{
					operation: 'exec',
					providerId: 'test.remote',
					completion: 'confirmed'
				},
				{ cause }
			)
	},
	{
		name: 'SandboxTransportError',
		create: (cause: unknown) =>
			new SandboxTransportError(
				{ operation: 'exec', providerId: 'test.remote', reason: 'shutdown' },
				{ cause }
			)
	},
	{
		name: 'UnconfirmedSandboxTerminationError',
		create: (cause: unknown) =>
			new UnconfirmedSandboxTerminationError(
				{ operation: 'exec', providerId: 'test.remote', reason: 'shutdown' },
				{ cause }
			)
	}
] satisfies readonly {
	readonly name: string;
	readonly create: (cause: unknown) => SandboxErrorInfo;
}[];
it.each(cases)(
	'constructs and rehydrates the concrete $name',
	({ name, create }) => {
		const cause = new Error('private provider detail');
		const original = create(cause);
		const restored = rehydrateSandboxError(original, { cause });
		for (const error of [original, restored]) {
			expect(JSON.stringify(error)).toBe(JSON.stringify(original));
			expect({
				name: error.name,
				cause: error.cause,
				message: error.message,
				recognised: isSandboxError(error)
			}).toStrictEqual({
				name,
				cause,
				message: original.message,
				recognised: true
			});
			expect(error.message.length).toBeGreaterThan(0);
			expect(error).toBeInstanceOf(Error);
			expect(error).toBeInstanceOf(SandboxError);
			expect(error).toBeInstanceOf(original.constructor);
			expect(error).not.toHaveProperty('code');
			expect(error).not.toHaveProperty('failure');
			expect(JSON.stringify(error)).not.toContain('private provider detail');
		}
	}
);
