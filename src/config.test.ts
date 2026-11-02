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

async function withSources(
	run: (
		sources: ConfigSources & { readonly workspace: string }
	) => Promise<void>
) {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-settings-'));
	const sources = {
		agentDirectory: path.join(directory, 'agent'),
		workspace: path.join(directory, 'workspace')
	};

	try {
		await mkdir(sources.agentDirectory);
		await mkdir(path.join(sources.workspace, '.pi'), { recursive: true });
		await run(sources);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it('reads cleanup budgets only from personal settings', async () => {
	await withSources(async (sources) => {
		await writeFile(
			path.join(sources.workspace, '.pi', 'byos.json'),
			JSON.stringify({ cleanup: { cancellationGraceMs: 1 } })
		);
		await writeFile(
			path.join(sources.agentDirectory, 'byos.json'),
			JSON.stringify({ cleanup: { cancellationGraceMs: 8000 } })
		);

		const config = await readConfig(sources);

		expect(config.cleanup).toStrictEqual({
			cancellationGraceMs: 8000
		});
	});
});

it.each([0, -1, 1.5, 300_001, '5000', { value: 5000 }])(
	'rejects an invalid cleanup budget: %j',
	async (value) => {
		await withSources(async (sources) => {
			await writeFile(
				path.join(sources.agentDirectory, 'byos.json'),
				JSON.stringify({ cleanup: { cancellationGraceMs: value } })
			);
			await expect(readConfig(sources)).rejects.toMatchObject({
				name: 'InvalidSandboxConfigError',
				configurationSource: 'personal'
			});
		});
	}
);

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
	'invalid JSON',
	'{"provider":"passthrough"}',
	'{"approval":{"policy":"always"}}'
])(
	'uses personal configuration independently of workspace files: %s',
	async (contents) => {
		await withSources(async (sources) => {
			await writeFile(
				path.join(sources.agentDirectory, 'byos.json'),
				JSON.stringify({
					provider: 'personal',
					policy: isolatedPolicy,
					providerConfig: { image: 'personal-image' }
				})
			);
			await writeFile(
				path.join(sources.workspace, '.pi', 'byos.json'),
				contents
			);
			expect(await readConfig(sources)).toStrictEqual({
				selection: {
					providerId: 'personal',
					source: 'personal',
					policy: isolatedPolicy
				},
				providerConfig: { image: 'personal-image' },
				providerConfigSource: 'personal',
				policySource: 'personal'
			});
		});
	}
);

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

it('propagates an unreadable personal configuration entry', async () => {
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
	});
});

function service(id: string): ProviderServiceV1 {
	return {
		id,
		label: id,
		capabilities: {
			processKinds: ['argv'],
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: []
		},
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
