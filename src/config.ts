import { lstat, readFile } from 'node:fs/promises';
import path from 'node:path';

import type { SandboxPolicy, ShellDialect } from './contracts.js';
import {
	InvalidSandboxConfigError,
	ProviderNotFoundError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type { ProviderSelection, ProviderServiceV1 } from './protocol.js';
import { isNonEmptyString, isPolicy, isRecord, isShell } from './validation.js';

export interface ConfigSources {
	readonly agentDirectory: string;
	readonly workspace: string;
	readonly isProjectTrusted: boolean;
}

export interface SandboxConfig {
	readonly selection: ProviderSelection;
	readonly providerConfig: unknown;
	readonly providerConfigSource?: 'personal' | 'project';
	readonly policySource?: 'personal' | 'project';
}

interface ConfigFile {
	readonly provider?: string;
	readonly policy?: SandboxPolicy;
	readonly userShell?: ShellDialect;
	readonly providerConfig?: unknown;
}

const defaultPolicy: SandboxPolicy = Object.freeze({
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
});

function isConfigFile(value: unknown): value is ConfigFile {
	if (
		!isRecord(value) ||
		Object.keys(value).some(
			(key) =>
				!['provider', 'policy', 'userShell', 'providerConfig'].includes(key)
		)
	) {
		return false;
	}

	if (value.provider !== undefined && !isNonEmptyString(value.provider)) {
		return false;
	}

	if (value.userShell !== undefined && !isShell(value.userShell)) {
		return false;
	}

	return (
		value.policy === undefined ||
		(isPolicy(value.policy) &&
			Object.keys(value.policy).every((key) =>
				['workspaceAccess', 'filesystemScope', 'networkAccess'].includes(key)
			))
	);
}

async function readConfigFile(
	filename: string,
	source: 'personal' | 'project'
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
	const { agentDirectory, workspace, isProjectTrusted } = sources;
	const personal = await readConfigFile(
		path.join(agentDirectory, 'byos.json'),
		'personal'
	);
	const project = isProjectTrusted
		? await readConfigFile(path.join(workspace, '.pi', 'byos.json'), 'project')
		: {};
	const merged = { ...personal, ...project };
	const providerId = merged.provider ?? 'passthrough';
	const source =
		project.provider === undefined
			? personal.provider === undefined
				? 'default'
				: 'personal'
			: 'project';
	const policy =
		merged.policy ?? (providerId === 'passthrough' ? defaultPolicy : undefined);
	if (policy === undefined) {
		throw new InvalidSandboxConfigError({
			operation: 'configure',
			providerId,
			...(source !== 'default' && { configurationSource: source })
		});
	}

	const isProviderChanged =
		project.provider !== undefined &&
		project.provider !== (personal.provider ?? 'passthrough');
	const mergedProviderConfig = Object.hasOwn(merged, 'providerConfig')
		? merged.providerConfig
		: {};
	const providerConfig =
		isProviderChanged && !Object.hasOwn(project, 'providerConfig')
			? {}
			: mergedProviderConfig;
	const selection: ProviderSelection = Object.freeze({
		providerId,
		source,
		policy: Object.freeze({ ...policy }),
		...(merged.userShell !== undefined && { userShell: merged.userShell })
	});
	const policySource =
		project.policy === undefined
			? personal.policy === undefined
				? undefined
				: 'personal'
			: 'project';
	const providerConfigSource = Object.hasOwn(project, 'providerConfig')
		? 'project'
		: !isProviderChanged && Object.hasOwn(personal, 'providerConfig')
			? 'personal'
			: undefined;

	return Object.freeze({
		selection,
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
		!provider.policies.filesystemScope.includes(policy.filesystemScope) ||
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
