import type {
	Sandbox,
	SandboxAcquireOptions,
	SandboxCapabilities,
	SandboxErrorContext
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	UnsupportedSandboxCapabilityError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { operationOptions } from './file-input.js';
import { hasRequiredGuarantees } from './guarantees.js';
import { acquireOptionsSchema } from './request-schemas.js';
import { checker } from './schemas.js';
import { isTerminationScopeSatisfied } from './termination-scope.js';
import {
	isWorkspaceProtectionSatisfied,
	snapshotWorkspaceProtection
} from './workspace-protection.js';

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
		...(value.terminationScope !== undefined && {
			terminationScope: value.terminationScope
		}),
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
		...(value.guarantees !== undefined && {
			guarantees: Object.freeze([...value.guarantees])
		}),
		...(value.needs !== undefined && {
			needs: Object.freeze([...value.needs])
		}),
		...(value.workspaceRelationship !== undefined && {
			workspaceRelationship: value.workspaceRelationship
		}),
		...(value.workspaceProtection !== undefined && {
			workspaceProtection: snapshotWorkspaceProtection(
				value.workspaceProtection
			)
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

	checkCapabilityRequirements(sandbox.capabilities, options, identity);

	if (
		(options.workspaceRelationship !== undefined &&
			options.workspaceRelationship !== sandbox.workspace.relationship) ||
		!hasRequiredGuarantees(
			sandbox.policy,
			options.guarantees ?? [],
			options.needs ?? []
		) ||
		!isWorkspaceProtectionSatisfied(sandbox.policy, options)
	) {
		throw new UnsupportedSandboxPolicyError(identity);
	}
}

export function checkCapabilityRequirements(
	capabilities: SandboxCapabilities,
	options: SandboxAcquireOptions,
	identity: SandboxErrorContext
): void {
	if (
		(options.terminationScope !== undefined &&
			!isTerminationScopeSatisfied(
				capabilities.terminationScope,
				options.terminationScope
			)) ||
		options.processKinds?.some(
			(kind) => !capabilities.processKinds.includes(kind)
		) ||
		options.shells?.some((shell) => !capabilities.shells.includes(shell)) ||
		(options.exitStatus === 'guaranteed' &&
			capabilities.exitStatus !== 'guaranteed') ||
		options.capabilities?.some(
			(capability) => !capabilities.operations.includes(capability)
		)
	) {
		throw new UnsupportedSandboxCapabilityError(identity);
	}
}
