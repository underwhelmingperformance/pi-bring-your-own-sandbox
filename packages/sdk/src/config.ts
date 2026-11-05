import type { ApprovalSelection } from './approval-contracts.js';
import type {
	SandboxCleanupBudgets,
	SandboxProviderConfig
} from './contracts.js';
import {
	InvalidSandboxConfigError,
	ProviderNotFoundError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { isFilesystemScopeSatisfied } from './filesystem-scope.js';
import type { ProviderSelection, ProviderServiceV1 } from './protocol.js';
import { isPolicy, snapshotPolicy } from './validation.js';
import { canProtectWorkspace } from './workspace-protection.js';

export interface SandboxConfig {
	readonly cleanup?: Partial<SandboxCleanupBudgets>;
	readonly selection: ProviderSelection;
	readonly approval?: ApprovalSelection;
	readonly outsideSandbox?: { readonly destination: 'normal' | 'provider' };
	readonly providerConfig: unknown;
	readonly providerConfigSource?: 'extension';
	readonly policySource?: 'extension';
}

export function resolveSandboxConfig(
	provider: ProviderServiceV1,
	configured: SandboxProviderConfig<unknown>,
	source: ProviderSelection['source']
): SandboxConfig {
	const policy = configured.policy ?? provider.defaultPolicy;

	if (!isPolicy(policy)) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId: provider.id,
			configurationSource: 'extension'
		});
	}

	return Object.freeze({
		selection: Object.freeze({
			providerId: provider.id,
			source,
			policy: snapshotPolicy(policy),
			...(configured.userShell !== undefined && {
				userShell: configured.userShell
			})
		}),
		providerConfig: configured.configuration,
		...(source === 'extension' && {
			providerConfigSource: 'extension' as const
		}),
		...(configured.policy !== undefined && {
			policySource: 'extension' as const
		}),
		...(configured.cleanup !== undefined && {
			cleanup: Object.freeze({ ...configured.cleanup })
		})
	});
}

export function selectProvider(
	config: SandboxConfig,
	providers: readonly ProviderServiceV1[]
): ProviderServiceV1 {
	const { providerId, policy } = config.selection;
	const provider = providers.find((candidate) => candidate.id === providerId);

	if (provider === undefined) {
		throw new ProviderNotFoundError({
			operation: 'configure',
			providerId
		});
	}

	if (
		!canProtectWorkspace(provider.capabilities, policy) ||
		!provider.policies.workspaceAccess.includes(policy.workspaceAccess) ||
		provider.policies.filesystemScope.every(
			(scope) => !isFilesystemScopeSatisfied(scope, policy.filesystemScope)
		) ||
		!provider.policies.networkAccess.includes(policy.networkAccess)
	) {
		throw new UnsupportedSandboxPolicyError({
			operation: 'configure',
			providerId,
			...(config.policySource !== undefined && {
				configurationSource: config.policySource
			})
		});
	}

	return provider;
}
