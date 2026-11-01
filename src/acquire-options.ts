import { isPolicySatisfied } from './backend-validation.js';
import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxPolicy
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { operationOptions } from './file-input.js';
import {
	isCapability,
	isFilesystemScope,
	isNetworkAccess,
	isRecord,
	isUniqueList,
	isWorkspaceAccess
} from './validation.js';

function isPartialPolicy(value: unknown): value is Partial<SandboxPolicy> {
	return (
		isRecord(value) &&
		Object.entries(value).every(([key, item]) => {
			if (key === 'workspaceAccess') {
				return item === undefined || isWorkspaceAccess(item);
			}

			if (key === 'filesystemScope') {
				return item === undefined || isFilesystemScope(item);
			}

			if (key === 'networkAccess') {
				return item === undefined || isNetworkAccess(item);
			}

			return false;
		})
	);
}

export function acquireOptions(input: unknown): SandboxAcquireOptions {
	const value = input === undefined ? {} : input;

	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(key) => !['signal', 'timeoutMs', 'capabilities', 'policy'].includes(key)
		) ||
		(value.capabilities !== undefined &&
			!isUniqueList(value.capabilities, isCapability)) ||
		(value.policy !== undefined && !isPartialPolicy(value.policy))
	) {
		throw new InvalidSandboxRequestError({ operation: 'acquire' });
	}

	const options = operationOptions(
		{ signal: value.signal, timeoutMs: value.timeoutMs },
		'acquire'
	);

	return Object.freeze({
		...options,
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
