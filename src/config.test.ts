import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import type { ConfigSources } from './config.js';
import { readConfig, selectProvider } from './config.js';
import type { ProviderServiceV1 } from './protocol.js';

const isolatedPolicy = {
	workspaceAccess: 'read-write',
	filesystemScope: 'workspace-only',
	networkAccess: 'denied'
} as const;
const defaultPolicy = {
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
} as const;

it.each(['personal', 'project'] as const)(
	'identifies %s settings when a selected provider has no policy',
	async (source) => {
		await withSources(async (sources) => {
			const filename =
				source === 'personal'
					? path.join(sources.agentDirectory, 'byos.json')
					: path.join(sources.workspace, '.pi', 'byos.json');

			await writeFile(filename, JSON.stringify({ provider: 'external' }));
			await expect(readConfig(sources)).rejects.toMatchObject({
				name: 'InvalidSandboxConfigError',
				configurationSource: source
			});
		});
	}
);

async function withSources(run: (sources: ConfigSources) => Promise<void>) {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-settings-'));
	const sources = {
		agentDirectory: path.join(directory, 'agent'),
		workspace: path.join(directory, 'workspace'),
		isProjectTrusted: true
	};

	try {
		await mkdir(sources.agentDirectory);
		await mkdir(path.join(sources.workspace, '.pi'), { recursive: true });
		await run(sources);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it('uses the implicit host default without creating any configuration', async () => {
	await withSources(async (sources) => {
		expect(await readConfig(sources)).toStrictEqual({
			selection: {
				providerId: 'passthrough',
				source: 'default',
				policy: defaultPolicy
			},
			providerConfig: {}
		});
	});
});

it.each([
	{
		project: {},
		expected: {
			providerId: 'personal',
			source: 'personal',
			policy: isolatedPolicy
		},
		config: { secretReference: 'personal' },
		configSource: 'personal'
	},
	{
		project: { provider: 'other' },
		expected: {
			providerId: 'other',
			source: 'project',
			policy: isolatedPolicy
		},
		config: {},
		configSource: undefined
	},
	{
		project: { provider: 'personal' },
		expected: {
			providerId: 'personal',
			source: 'project',
			policy: isolatedPolicy
		},
		config: { secretReference: 'personal' },
		configSource: 'personal'
	},
	{
		project: { providerConfig: { image: 'project' } },
		expected: {
			providerId: 'personal',
			source: 'personal',
			policy: isolatedPolicy
		},
		config: { image: 'project' },
		configSource: 'project'
	},
	{
		project: { provider: 'passthrough', policy: defaultPolicy },
		expected: {
			providerId: 'passthrough',
			source: 'project',
			policy: defaultPolicy
		},
		config: {},
		configSource: undefined
	}
])(
	'merges top-level settings by replacement: $project',
	async ({ project, expected, config, configSource }) => {
		await withSources(async (sources) => {
			await writeFile(
				path.join(sources.agentDirectory, 'byos.json'),
				JSON.stringify({
					provider: 'personal',
					policy: isolatedPolicy,
					providerConfig: { secretReference: 'personal' }
				})
			);
			await writeFile(
				path.join(sources.workspace, '.pi', 'byos.json'),
				JSON.stringify(project)
			);

			expect(await readConfig(sources)).toStrictEqual({
				selection: expected,
				providerConfig: config,
				policySource: Object.hasOwn(project, 'policy') ? 'project' : 'personal',
				...(configSource !== undefined && {
					providerConfigSource: configSource
				})
			});
		});
	}
);

it('does not read project configuration before Pi grants trust', async () => {
	await withSources(async (sources) => {
		await writeFile(
			path.join(sources.workspace, '.pi', 'byos.json'),
			'invalid JSON'
		);
		expect(
			await readConfig({ ...sources, isProjectTrusted: false })
		).toStrictEqual({
			selection: {
				providerId: 'passthrough',
				source: 'default',
				policy: defaultPolicy
			},
			providerConfig: {}
		});
	});
});

it.each([
	'not JSON',
	'null',
	'[]',
	'{"provider":null}',
	'{"provider":""}',
	'{"provider":"external"}',
	'{"unknown":true}',
	'{"userShell":"zsh"}',
	'{"policy":{"workspaceAccess":"read-write"}}',
	'{"policy":{"workspaceAccess":"read-write","filesystemScope":"provider-default","networkAccess":"provider-default","extra":true}}'
])(
	'rejects malformed personal configuration without assuming host execution: %s',
	async (contents) => {
		await withSources(async (sources) => {
			await writeFile(path.join(sources.agentDirectory, 'byos.json'), contents);
			await expect(readConfig(sources)).rejects.toMatchObject({
				name: 'InvalidSandboxConfigError',
				operation: 'configure'
			});
		});
	}
);

it('propagates an unreadable configuration entry and validates both sources', async () => {
	await withSources(async (sources) => {
		await mkdir(path.join(sources.agentDirectory, 'byos.json'));
		await writeFile(
			path.join(sources.workspace, '.pi', 'byos.json'),
			JSON.stringify({ provider: 'passthrough' })
		);
		await expect(readConfig(sources)).rejects.toMatchObject({
			name: 'InvalidSandboxConfigError'
		});
	});
});

it('does not interpret a dangling configuration symlink as an absent file', async () => {
	await withSources(async (sources) => {
		await symlink(
			'missing.json',
			path.join(sources.agentDirectory, 'byos.json')
		);
		await expect(readConfig(sources)).rejects.toMatchObject({
			name: 'InvalidSandboxConfigError'
		});
	});
});

it.each(['null', 'false', '0', '"value"', '[]', '{}'])(
	'preserves provider-owned configuration without coercion: %s',
	async (payload) => {
		await withSources(async (sources) => {
			await writeFile(
				path.join(sources.agentDirectory, 'byos.json'),
				`{"providerConfig":${payload}}`
			);

			const expected: unknown = JSON.parse(payload);

			expect(await readConfig(sources)).toStrictEqual({
				selection: {
					providerId: 'passthrough',
					source: 'default',
					policy: defaultPolicy
				},
				providerConfig: expected,
				providerConfigSource: 'personal'
			});
		});
	}
);

it('requires a complete replacement policy and retains an explicit shell dialect', async () => {
	await withSources(async (sources) => {
		await writeFile(
			path.join(sources.agentDirectory, 'byos.json'),
			JSON.stringify({
				provider: 'external',
				policy: isolatedPolicy,
				userShell: 'sh'
			})
		);
		expect(await readConfig(sources)).toStrictEqual({
			selection: {
				providerId: 'external',
				source: 'personal',
				policy: isolatedPolicy,
				userShell: 'sh'
			},
			policySource: 'personal',
			providerConfig: {}
		});
		await writeFile(
			path.join(sources.workspace, '.pi', 'byos.json'),
			JSON.stringify({ policy: { networkAccess: 'denied' } })
		);
		await expect(readConfig(sources)).rejects.toMatchObject({
			name: 'InvalidSandboxConfigError'
		});
	});
});

function service(id: string): ProviderServiceV1 {
	return {
		id,
		label: id,
		capabilities: { operations: ['exec'], shells: [] },
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		configure: () => ({
			open: () => Promise.reject(new Error('Selection must not allocate.'))
		})
	};
}

it('does not automatically select an installed external provider', async () => {
	await withSources(async (sources) => {
		const config = await readConfig(sources);
		const passthrough = service('passthrough');

		expect(selectProvider(config, [passthrough, service('external')])).toBe(
			passthrough
		);
	});
});

it.each([
	{
		selection: {
			providerId: 'missing',
			source: 'personal',
			policy: defaultPolicy
		},
		name: 'ProviderNotFoundError'
	},
	{
		selection: {
			providerId: 'passthrough',
			source: 'personal',
			policy: isolatedPolicy
		},
		name: 'UnsupportedSandboxPolicyError'
	}
] as const)(
	'rejects an unsatisfied selection without a host fallback: $name',
	({ selection, name }) => {
		expect(() =>
			selectProvider({ selection, providerConfig: {} }, [
				service('passthrough')
			])
		).toThrow(expect.objectContaining({ name }));
	}
);
