import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxErrorContext
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { operationOptions } from './file-input.js';
import type { ProfileRefusal } from './profile-negotiation.js';
import { selectProfile } from './profile-negotiation.js';
import { acquireOptionsSchema, invalidField } from './request-schemas.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

const isAcquireOptions = checker(acquireOptionsSchema);

export function acquireOptions(
	input: unknown,
	extensionSource?: string
): SandboxAcquireOptions {
	const value = input === undefined ? {} : input;

	if (!isAcquireOptions(value)) {
		const keys = invalidField(acquireOptionsSchema, value);
		let invalid: unknown = value;

		for (const key of keys) {
			invalid =
				(isRecord(invalid) || Array.isArray(invalid)) &&
				Object.hasOwn(invalid, key)
					? Reflect.get(invalid, key)
					: undefined;
		}

		const rejected = invalid;
		const isScalar =
			typeof rejected === 'string' ||
			typeof rejected === 'boolean' ||
			(typeof rejected === 'number' && Number.isFinite(rejected));

		throw new InvalidSandboxRequestError({
			operation: 'acquire',
			...(extensionSource !== undefined && { extensionSource }),
			detail: {
				kind: 'request',
				field: keys.join('.') || 'options',
				...(isScalar && { value: rejected })
			}
		});
	}

	const { signal: _signal, ...requirements } = value;
	const options = operationOptions(
		{ signal: value.signal, timeoutMs: value.timeoutMs },
		'acquire'
	);

	return Object.freeze({ ...structuredClone(requirements), ...options });
}

export function refuseProfile(
	detail: ProfileRefusal,
	identity: SandboxErrorContext
): never {
	if (detail.kind === 'capability') {
		throw new UnsupportedSandboxCapabilityError({ ...identity, detail });
	}

	throw new UnsupportedSandboxPolicyError({ ...identity, detail });
}

export function checkRequirements(
	sandbox: Sandbox,
	options: SandboxAcquireOptions,
	extensionSource?: string
): void {
	const identity = {
		operation: 'acquire' as const,
		providerId: sandbox.providerId,
		backendId: sandbox.backendId,
		...(extensionSource !== undefined && { extensionSource })
	};
	const profile = {
		...sandbox.capabilities,
		capabilities: sandbox.capabilities.operations,
		policy: sandbox.policy
	};
	const result = selectProfile({
		profiles: [profile],
		limit: sandbox.policy,
		requirements: options
	});

	if (!result.ok) {
		refuseProfile(result.detail, identity);
	}
}
