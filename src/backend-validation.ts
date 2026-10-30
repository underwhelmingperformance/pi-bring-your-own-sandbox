import path from 'node:path';

import type {
	BackendFiles,
	BackendSearch,
	SandboxBackend,
	SandboxCapabilities,
	SandboxPolicy,
	SandboxWorkspace
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { ProviderInfo } from './protocol.js';
import {
	isCapabilities,
	isNonEmptyString,
	isPolicy,
	isRecord,
	isRecovery,
	isShell
} from './validation.js';

function hasMatchingMethods(
	value: unknown,
	isAdvertised: boolean,
	methods: readonly string[]
): boolean {
	return value === undefined
		? !isAdvertised
		: isAdvertised &&
				isRecord(value) &&
				methods.every((method) => typeof value[method] === 'function');
}

function isFiles(
	value: unknown,
	capabilities: SandboxCapabilities
): value is BackendFiles | undefined {
	return value === undefined
		? capabilities.operations.every(
				(operation) => !operation.startsWith('files.')
			)
		: isRecord(value) &&
				hasMatchingMethods(
					value.read,
					capabilities.operations.includes('files.read'),
					['readFile', 'access', 'stat']
				) &&
				hasMatchingMethods(
					value.write,
					capabilities.operations.includes('files.write'),
					['writeFile', 'access', 'mkdir']
				) &&
				hasMatchingMethods(
					value.list,
					capabilities.operations.includes('files.list'),
					['listDirectory', 'stat']
				);
}

function isSearch(
	value: unknown,
	capabilities: SandboxCapabilities
): value is BackendSearch | undefined {
	if (value === undefined) {
		return capabilities.operations.every(
			(operation) => !operation.startsWith('search.')
		);
	}

	if (!isRecord(value)) {
		return false;
	}

	return (
		(value.find === undefined
			? !capabilities.operations.includes('search.find')
			: typeof value.find === 'function' &&
				capabilities.operations.includes('search.find')) &&
		(value.grep === undefined
			? !capabilities.operations.includes('search.grep')
			: typeof value.grep === 'function' &&
				capabilities.operations.includes('search.grep'))
	);
}

function isWorkspace(
	value: unknown,
	capabilities: SandboxCapabilities
): value is SandboxWorkspace {
	if (
		!isRecord(value) ||
		(value.pathFlavor !== 'posix' && value.pathFlavor !== 'win32')
	) {
		return false;
	}

	const targetPaths = value.pathFlavor === 'posix' ? path.posix : path.win32;
	const isAbsolute = (input: unknown): input is string =>
		isNonEmptyString(input) &&
		!input.includes('\0') &&
		targetPaths.isAbsolute(input);
	return (
		isAbsolute(value.root) &&
		isNonEmptyString(value.description) &&
		typeof value.relationship === 'string' &&
		['shared', 'copied', 'remote'].includes(value.relationship) &&
		(value.home === undefined || isAbsolute(value.home)) &&
		(value.defaultShell === undefined ||
			(isShell(value.defaultShell) &&
				capabilities.shells.includes(value.defaultShell)))
	);
}

function isBackend(value: unknown): value is SandboxBackend {
	return (
		isRecord(value) &&
		isNonEmptyString(value.id) &&
		isCapabilities(value.capabilities) &&
		isWorkspace(value.workspace, value.capabilities) &&
		isPolicy(value.policy) &&
		isNonEmptyString(value.policyDescription) &&
		isRecovery(value.recovery) &&
		typeof value.exec === 'function' &&
		typeof value.dispose === 'function' &&
		isFiles(value.files, value.capabilities) &&
		isSearch(value.search, value.capabilities)
	);
}

export function isPolicySatisfied(
	effective: SandboxPolicy,
	required: Partial<SandboxPolicy>
): boolean {
	return (
		(required.workspaceAccess === undefined ||
			effective.workspaceAccess === required.workspaceAccess) &&
		(required.filesystemScope === undefined ||
			required.filesystemScope === 'provider-default' ||
			effective.filesystemScope === required.filesystemScope) &&
		(required.networkAccess === undefined ||
			required.networkAccess === 'provider-default' ||
			effective.networkAccess === required.networkAccess)
	);
}

export function validateBackend(
	value: unknown,
	provider: ProviderInfo,
	required: SandboxPolicy
): SandboxBackend {
	if (
		!isBackend(value) ||
		value.capabilities.operations.some(
			(operation) => !provider.capabilities.operations.includes(operation)
		) ||
		value.capabilities.shells.some(
			(shell) => !provider.capabilities.shells.includes(shell)
		) ||
		!provider.policies.workspaceAccess.includes(value.policy.workspaceAccess) ||
		!provider.policies.filesystemScope.includes(value.policy.filesystemScope) ||
		!provider.policies.networkAccess.includes(value.policy.networkAccess)
	) {
		throw new InvalidSandboxDeclarationError({
			operation: 'open',
			providerId: provider.id
		});
	}

	if (!isPolicySatisfied(value.policy, required)) {
		throw new UnsupportedSandboxPolicyError({
			operation: 'open',
			providerId: provider.id,
			backendId: value.id
		});
	}

	return value;
}
