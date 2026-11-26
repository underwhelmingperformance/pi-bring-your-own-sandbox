import { realpath } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import path from 'node:path';

import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { verifyGrantedPaths } from './backend-validation.js';
import { createSandboxClient } from './client.js';
import type {
	SandboxBackend,
	SandboxClient,
	SandboxContext
} from './contracts.js';
import { isSandboxError, UnsupportedSandboxPolicyError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { SandboxGeneration } from './generation.js';
import { OperationScope } from './lifecycle.js';
import type { Profile } from './policy-model.js';
import { defaultPolicy } from './policy-model.js';
import { registerSandboxProvider } from './provider-registration.js';

const source = '<inline:policy-provider>';
const consumer = '<inline:policy-consumer>';
const profile: Profile = {
	policy: { ...defaultPolicy, hostSystemFiles: 'denied' },
	capabilities: ['exec'],
	processKinds: ['argv'],
	shells: [],
	exitStatus: 'guaranteed',
	terminationScope: 'workload'
};

async function fixture(
	run: (
		client: SandboxClient,
		context: SandboxContext,
		opens: readonly Profile[]
	) => Promise<void>,
	openBackend?: (chosen: Profile) => SandboxBackend
): Promise<void> {
	const opens: Profile[] = [];
	const outcomes: string[] = [];

	await withPiRuntime(
		[
			{
				name: 'policy-provider',
				factory(pi) {
					registerSandboxProvider(pi, source, {
						id: 'fixture.policy',
						label: 'Profile fixture',
						profiles: { open: [profile], copy: [] },
						validateConfig: () => ({}),
						open(request) {
							opens.push(request.profile);

							const backend =
								openBackend?.(request.profile) ??
								Object.assign(new MemoryBackend('exec'), {
									policy: request.profile.policy,
									workspace: {
										root: '/fixture/workspace',
										pathFlavor: 'posix' as const,
										relationship: 'shared' as const,
										description: 'In-memory fixture.'
									}
								});

							return Promise.resolve(backend);
						}
					});
				}
			},
			{
				name: 'policy-consumer',
				factory(pi) {
					const client = createSandboxClient(pi, consumer);

					pi.on('session_start', async (_event, context) => {
						await run(client, context, opens);
						outcomes.push('checked');
					});
				}
			}
		],
		(_runtime, errors) => {
			expect({ errors, outcomes }).toStrictEqual({
				errors: [],
				outcomes: ['checked']
			});

			return Promise.resolve();
		},
		{ bindFixtureSources: false }
	);
}

it('uses the same profile to negotiate and open, with no allocation during negotiation', async () => {
	await fixture(async (client, context, opens) => {
		const result = await client.negotiate(context);

		expect({ result, opens: [...opens] }).toStrictEqual({
			result: { ok: true, profile },
			opens: []
		});

		const sandbox = await client.get(context);

		expect({ effective: sandbox.policy, opens }).toStrictEqual({
			effective: profile.policy,
			opens: [profile]
		});
	});
});

it('rejects a path beyond the configured policy with its resolved value and source before opening', async () => {
	await fixture(async (client, context, opens) => {
		const result = await client.negotiate(context, {
			access: { paths: { read: ['~/.byos-profile-fixture'] } }
		});

		if (
			result.ok ||
			!isSandboxError(result.error, UnsupportedSandboxPolicyError)
		) {
			throw new Error('The path should be refused.');
		}

		expect({
			name: result.error.name,
			detail: result.error.detail,
			extensionSource: result.error.extensionSource,
			opens
		}).toStrictEqual({
			name: 'UnsupportedSandboxPolicyError',
			detail: {
				kind: 'path',
				access: 'read',
				path: path.join(homedir(), '.byos-profile-fixture'),
				reason: 'limit'
			},
			extensionSource: consumer,
			opens: []
		});
	});
});

it.each(['profile', 'workspace.relationship'] as const)(
	'disposes a backend that reports a different %s',
	async (field) => {
		const disposed: string[] = [];

		await fixture(
			async (client, context) => {
				await expect(client.get(context)).rejects.toMatchObject({
					name: 'InvalidSandboxDeclarationError',
					extensionSource: source,
					detail: { kind: 'declaration', field }
				});
				expect(disposed).toStrictEqual(['disposed']);
			},
			(chosen) => {
				const backend = new MemoryBackend('exec');

				return Object.assign(backend, {
					policy:
						field === 'profile'
							? { ...chosen.policy, network: true }
							: chosen.policy,
					workspace: {
						...backend.workspace,
						relationship:
							field === 'workspace.relationship' ? 'copied' : 'shared'
					},
					dispose: () => {
						disposed.push('disposed');

						return Promise.resolve();
					}
				});
			}
		);
	}
);

it.each(['missing', 'outside target'] as const)(
	'disposes a backend with a %s workspace grant',
	async (defect) => {
		const disposed: string[] = [];
		let hostPath = '';

		await fixture(
			async (client, context) => {
				hostPath = await realpath(context.cwd);

				await expect(
					client.get(context, { access: { paths: { read: ['.'] } } })
				).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError',
					extensionSource: source,
					detail: {
						kind: 'path',
						access: 'read',
						path: hostPath,
						reason: 'unreachable'
					}
				});
				expect(disposed).toStrictEqual(['disposed']);
			},
			(chosen) =>
				Object.assign(new MemoryBackend('exec'), {
					policy: chosen.policy,
					grantedPaths:
						defect === 'missing'
							? []
							: [{ kind: 'read' as const, hostPath, targetPath: '/outside' }],
					dispose: () => {
						disposed.push('disposed');

						return Promise.resolve();
					}
				})
		);
	}
);

it.each([
	{ source: 'home', target: 'home', reachable: true },
	{ source: 'home', target: 'absolute', reachable: false },
	{ source: 'absolute', target: 'absolute', reachable: true },
	{ source: 'absolute', target: 'home', reachable: false }
] as const)(
	'checks an extra grant with $source source and $target target',
	async ({ source: location, target, reachable }) => {
		const filename = '.byos-grant-fixture';
		const hostHome = await realpath(homedir());
		const otherPath = '/host-data/' + filename;
		const hostPath =
			location === 'home' ? path.join(hostHome, filename) : otherPath;
		const scope = new OperationScope(
			{ operation: 'open' },
			new AbortController().signal,
			{},
			60_000
		);
		const backend = new MemoryBackend('exec');
		const provider = { id: 'fixture.policy' };

		try {
			const result = verifyGrantedPaths(
				Object.assign(backend, {
					workspace: { ...backend.workspace, home: '/target-home' },
					grantedPaths: [
						{
							kind: 'read' as const,
							hostPath,
							targetPath:
								target === 'home' ? '/target-home/' + filename : hostPath
						}
					]
				}),
				[{ kind: 'read', path: hostPath, location: 'host-user-data' }],
				scope.context,
				provider,
				true
			);

			if (reachable) {
				await expect(result).resolves.toBeUndefined();
			} else {
				await expect(result).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError',
					providerId: provider.id,
					detail: {
						kind: 'path',
						access: 'read',
						path: hostPath,
						reason: 'unreachable'
					}
				});
			}
		} finally {
			scope.dispose();
		}
	}
);

it.each([true, false])(
	'checks a declared extra path after opening and disposes the backend (correct placement: %s)',
	async (isCorrectPlacement) => {
		const workspace = await realpath(tmpdir());
		const home = await realpath(homedir());
		const context = {
			cwd: workspace,
			sessionManager: SessionManager.inMemory(workspace)
		};
		const { backend } = shellBackend();
		const withGrant = { ...backend.profile, pathGrantKinds: ['read'] as const };
		const opened: Profile[] = [];
		const disposed: string[] = [];
		const targetHome = '/fixture-home';
		const providerId = 'fixture.path-grant';
		const generation = new SandboxGeneration(context, {
			providers: () => [
				{
					id: providerId,
					label: 'Path grant fixture',
					profiles: { open: [withGrant], copy: [] },
					configure: () => ({
						open(request) {
							opened.push(request.profile);

							return Promise.resolve({
								...backend,
								profile: request.profile,
								workspace: { ...backend.workspace, home: targetHome },
								grantedPaths: [
									{
										kind: 'read',
										hostPath: request.paths?.read?.[0] ?? '',
										targetPath: isCorrectPlacement ? targetHome : '/wrong-home'
									}
								],
								dispose() {
									disposed.push(backend.id);

									return Promise.resolve();
								}
							});
						}
					})
				}
			],
			readConfig: () =>
				Promise.resolve({
					selection: {
						source: 'extension',
						providerId,
						policy: withGrant.policy
					},
					providerConfig: {}
				})
		});

		try {
			const plan = await generation.planEscalation(context, {
				access: { paths: { read: ['~'] } }
			});

			expect({ paths: plan.paths, opened }).toStrictEqual({
				paths: { read: [home] },
				opened: []
			});

			if (isCorrectPlacement) {
				const allocation = await plan.open(context);

				expect(allocation.sandbox.grantedPaths).toStrictEqual([
					{ kind: 'read', hostPath: home, targetPath: targetHome }
				]);
				await allocation.close();
			} else {
				await expect(plan.open(context)).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError',
					providerId,
					detail: {
						kind: 'path',
						access: 'read',
						path: home,
						reason: 'unreachable'
					}
				});
			}

			expect({ opened, disposed }).toStrictEqual({
				opened: [withGrant],
				disposed: [backend.id]
			});
		} finally {
			await generation.close();
		}
	}
);
