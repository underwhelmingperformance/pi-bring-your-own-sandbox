import { isPolicySatisfied } from './backend-validation.js';
import type { Sandbox, SandboxAcquireOptions } from './contracts.js';
import {
	InvalidSandboxRequestError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { operationOptions } from './file-input.js';
import { acquireOptionsSchema } from './request-schemas.js';
import { checker } from './schemas.js';

const isAcquireOptions = checker(acquireOptionsSchema);

export function acquireOptions(input: unknown): SandboxAcquireOptions {
	const value = input === undefined ? {} : input;

	if (!isAcquireOptions(value)) {
		throw new InvalidSandboxRequestError({ operation: 'acquire' });
	}

	const options = operationOptions(
		{ signal: value.signal, timeoutMs: value.timeoutMs },
		'acquire'
	);

	return Object.freeze({
		...options,
		...(value.processKinds !== undefined && {
			processKinds: Object.freeze([...value.processKinds])
		}),
		...(value.shells !== undefined && {
			shells: Object.freeze([...value.shells])
		}),
		...(value.exitStatus !== undefined && { exitStatus: value.exitStatus }),
		...(value.capabilities !== undefined && {
			capabilities: Object.freeze([...value.capabilities])
		}),
		...(value.policy !== undefined && {
			policy: Object.freeze({
				...(value.policy.workspaceAccess !== undefined && {
					workspaceAccess: value.policy.workspaceAccess
				}),
				...(value.policy.filesystemScope !== undefined && {
					filesystemScope: value.policy.filesystemScope
				}),
				...(value.policy.networkAccess !== undefined && {
					networkAccess: value.policy.networkAccess
				})
			})
		})
	});
}

export function checkRequirements(
	sandbox: Sandbox,
	options: SandboxAcquireOptions
): void {
	const identity = {
		operation: 'acquire' as const,
		providerId: sandbox.providerId,
		backendId: sandbox.backendId
	};

	if (
		options.processKinds?.some(
			(kind) => !sandbox.capabilities.processKinds.includes(kind)
		) ||
		options.shells?.some(
			(shell) => !sandbox.capabilities.shells.includes(shell)
		) ||
		(options.exitStatus === 'guaranteed' &&
			sandbox.capabilities.exitStatus !== 'guaranteed') ||
		options.capabilities?.some(
			(capability) => !sandbox.capabilities.operations.includes(capability)
		)
	) {
		throw new UnsupportedSandboxCapabilityError(identity);
	}

	if (
		options.policy !== undefined &&
		!isPolicySatisfied(sandbox.policy, { ...sandbox.policy, ...options.policy })
	) {
		throw new UnsupportedSandboxPolicyError(identity);
	}
}
