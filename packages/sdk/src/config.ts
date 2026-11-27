import type {
	SandboxCleanupBudgets,
	SandboxSharedSettings
} from './contracts.js';
import {
	InvalidSandboxConfigError,
	ProviderNotFoundError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { defaultPolicy, unrestrictedPolicy } from './policy-model.js';
import { selectProfile } from './profile-negotiation.js';
import type {
	ConfiguredProviderV1,
	ProviderSelection,
	ProviderServiceV1
} from './protocol.js';
import type { SaveReadRoots } from './read-root-persistence.js';
import { isPolicy, snapshotPolicy } from './validation.js';

export interface SandboxConfig {
	readonly cleanup?: Partial<SandboxCleanupBudgets>;
	readonly selection: ProviderSelection;
	readonly allowEscalation?: boolean;
	readonly hostUserDataRoots?: readonly string[];
	readonly saveReadRoots?: SaveReadRoots;
	readonly configured?: ConfiguredProviderV1;
	readonly providerConfigSource?: 'extension';
	readonly policySource?: 'extension';
}

export function resolveSandboxConfig(
	provider: ProviderServiceV1,
	settings: SandboxSharedSettings | undefined,
	source: ProviderSelection['source']
): SandboxConfig {
	const explicit = settings?.policy;
	const extensionSource = provider.protocol?.extensionSource;
	const limit =
		explicit ?? (source === 'default' ? unrestrictedPolicy : defaultPolicy);

	if (!isPolicy(limit)) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId: provider.id,
			configurationSource: 'extension',
			detail: { kind: 'config', field: 'settings.policy' },
			...(extensionSource !== undefined && { extensionSource })
		});
	}

	const selected = selectProfile({ profiles: provider.profiles.open, limit });

	if (!selected.ok) {
		throw new UnsupportedSandboxPolicyError({
			operation: 'configure',
			providerId: provider.id,
			detail: selected.detail,
			...(extensionSource !== undefined && { extensionSource }),
			...(source === 'extension' && { configurationSource: 'extension' })
		});
	}

	const policy = explicit ?? selected.profile.policy;

	return Object.freeze({
		allowEscalation: settings?.allowEscalation ?? true,
		selection: Object.freeze({
			providerId: provider.id,
			source,
			policy: snapshotPolicy(policy),
			...(settings?.userShell !== undefined && {
				userShell: settings.userShell
			})
		}),
		...(source === 'extension' && {
			providerConfigSource: 'extension' as const
		}),
		...(explicit !== undefined && {
			policySource: 'extension' as const
		}),
		...(settings?.cleanup !== undefined && {
			cleanup: Object.freeze({ ...settings.cleanup })
		})
	});
}

export function selectProvider(
	config: SandboxConfig,
	providers: readonly ProviderServiceV1[]
): ProviderServiceV1 {
	const { providerId } = config.selection;
	const provider = providers.find((candidate) => candidate.id === providerId);

	if (provider === undefined) {
		throw new ProviderNotFoundError({
			operation: 'configure',
			providerId
		});
	}

	return provider;
}
