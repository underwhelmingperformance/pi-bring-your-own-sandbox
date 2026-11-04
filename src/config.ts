import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { Static } from 'typebox';

import type { ApprovalSelection } from './approval-contracts.js';
import { builtinProviders } from './builtin-providers.js';
import type { SandboxCleanupBudgets } from './contracts.js';
import {
	InvalidSandboxConfigError,
	ProviderNotFoundError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { isFilesystemScopeSatisfied } from './filesystem-scope.js';
import type {
	ProviderInfo,
	ProviderSelection,
	ProviderServiceV1
} from './protocol.js';
import { configFileSchema } from './request-schemas.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

export interface ConfigSources {
	readonly agentDirectory: string;
	readonly defaultProvider?: ProviderInfo;
	readonly providers?: readonly ProviderInfo[];
}

export interface SandboxConfig {
	readonly cleanup?: Partial<SandboxCleanupBudgets>;
	readonly selection: ProviderSelection;
	readonly approval?: ApprovalSelection;
	readonly outsideSandbox?: { readonly destination: 'normal' | 'provider' };
	readonly providerConfig: unknown;
	readonly providerConfigSource?: 'personal';
	readonly policySource?: 'personal';
}

type ConfigFile = Static<typeof configFileSchema>;

const isConfigFile = checker(configFileSchema);

async function readConfigFile(
	filename: string,
	source: 'personal'
): Promise<ConfigFile> {
	let hasEntry = false;

	try {
		await lstat(filename);
		hasEntry = true;

		const contents = await readFile(filename, 'utf8');
		const value: unknown = JSON.parse(contents);

		if (!isConfigFile(value)) {
			throw new InvalidSandboxConfigError({
				operation: 'configure',
				configurationSource: source
			});
		}

		return value;
	} catch (error) {
		if (!hasEntry && isRecord(error) && error.code === 'ENOENT') {
			return {};
		}

		throw new InvalidSandboxConfigError(
			{
				operation: 'configure',
				configurationSource: source
			},
			{ cause: error }
		);
	}
}

export async function readConfig(
	sources: ConfigSources
): Promise<SandboxConfig> {
	const personal = await readConfigFile(
		path.join(sources.agentDirectory, 'byos.json'),
		'personal'
	);
	const defaultProvider =
		sources.defaultProvider ?? builtinProviders.defaultProvider;
	const providers = sources.providers ?? builtinProviders.providers;
	const providerId = personal.provider ?? defaultProvider.id;
	const source = personal.provider === undefined ? 'default' : 'personal';
	const declared = [defaultProvider, ...providers].find(
		(provider) => provider.id === providerId
	);
	const policy = personal.policy ?? declared?.defaultPolicy;

	if (policy === undefined) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId,
			...(source !== 'default' && { configurationSource: source })
		});
	}

	const providerConfig = Object.hasOwn(personal, 'providerConfig')
		? personal.providerConfig
		: {};
	const selection: ProviderSelection = Object.freeze({
		providerId,
		source,
		policy: Object.freeze({ ...policy }),
		...(personal.userShell !== undefined && { userShell: personal.userShell })
	});
	const policySource = personal.policy === undefined ? undefined : 'personal';
	const providerConfigSource = Object.hasOwn(personal, 'providerConfig')
		? 'personal'
		: undefined;

	return Object.freeze({
		selection,
		...(personal.cleanup !== undefined && {
			cleanup: Object.freeze({ ...personal.cleanup })
		}),
		...(personal.approval !== undefined && {
			approval: Object.freeze({ ...personal.approval })
		}),
		...(personal.outsideSandbox !== undefined && {
			outsideSandbox: Object.freeze({ ...personal.outsideSandbox })
		}),
		providerConfig,
		...(policySource !== undefined && { policySource }),
		...(providerConfigSource !== undefined && { providerConfigSource })
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
