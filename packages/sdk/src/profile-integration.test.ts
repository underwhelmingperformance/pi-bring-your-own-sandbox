import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
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
import {
	isSandboxError,
	SandboxPermissionDeniedError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { contractScenario } from './fixtures/provider-contract.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { SandboxGeneration } from './generation.js';
import { OperationScope } from './lifecycle.js';
import type { Profile } from './policy-model.js';
import { defaultPolicy } from './policy-model.js';
import { verifyCredentialExclusion } from './provider-credential-suite.js';
import { registerSandboxProvider } from './provider-registration.js';
import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';

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
	openBackend?: (chosen: Profile) => SandboxBackend,
	selected: Profile = profile
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
						profiles: { open: [selected], copy: [] },
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
										hostUserDataRoot: '/fixture/host-user-data',
										description: 'In-memory fixture.'
									}
								});

							if (request.hostUserDataRoots !== undefined) {
								Object.assign(backend, {
									hostUserDataRoots: request.hostUserDataRoots
								});
							}

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
			access: { paths: { write: ['~/.byos-profile-fixture'] } }
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
				access: 'write',
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
						hostUserDataRoot: '/fixture/host-user-data',
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

it.each([
	{ access: 'read-only', root: undefined },
	{ access: 'read-only', root: 'relative-to-workspace' },
	{ access: 'read-only', root: '/mount/invalid\0path' },
	{ access: 'denied', root: '/mount/host-user-data' }
] as const)(
	'disposes a backend when host user data is $access and the root is $root',
	async ({ access, root }) => {
		const disposals: string[] = [];
		const selected = {
			...profile,
			policy: { ...profile.policy, hostUserData: access }
		};

		await fixture(
			async (client, context) => {
				await expect(client.get(context)).rejects.toMatchObject({
					name: 'InvalidSandboxDeclarationError',
					extensionSource: source,
					detail: { kind: 'declaration', field: 'workspace.hostUserDataRoot' }
				});
				expect(disposals).toStrictEqual(['disposed']);
			},
			(chosen) => {
				const backend = new MemoryBackend('exec');

				return Object.assign(backend, {
					policy: chosen.policy,
					workspace: {
						...backend.workspace,
						home: '/private-home',
						...(root !== undefined && { hostUserDataRoot: root })
					},
					dispose() {
						disposals.push('disposed');

						return Promise.resolve();
					}
				});
			},
			selected
		);
	}
);

it('publishes separate target home and host user data roots', async () => {
	const workspace = {
		root: '/fixture/workspace',
		pathFlavor: 'posix',
		relationship: 'shared',
		description: 'In-memory fixture',
		home: '/private-home',
		hostUserDataRoot: '/mount/host-user-data'
	} as const;

	await fixture(
		async (client, context) => {
			const sandbox = await client.get(context);

			expect(sandbox.workspace).toStrictEqual(workspace);
		},
		(chosen) =>
			Object.assign(new MemoryBackend('exec'), {
				policy: chosen.policy,
				workspace
			})
	);
});

it.each([
	[
		'uses the declared host data root for credential conformance',
		true,
		undefined,
		undefined
	],
	[
		'accepts capability refusal without a file writer',
		false,
		undefined,
		undefined
	],
	[
		'rejects a provider that accepts writes to ordinary user data',
		true,
		'ordinary.txt',
		'accepted'
	],
	[
		'rejects a provider that accepts writes to credentials',
		true,
		'.ssh',
		'accepted'
	],
	[
		'rejects a provider that changes a host marker before refusing the write',
		true,
		'.ssh',
		'changed'
	]
] as const)('%s', async (_label, hasWriter, affected, failure) => {
	const backend = new MemoryBackend();
	const hostUserDataRoot = '/mounted/home';
	const original = contractScenario();
	const policy = { ...defaultPolicy, hostSystemFiles: 'denied' } as const;

	Object.assign(backend, {
		policy,
		workspace: { ...backend.workspace, home: '/private-home', hostUserDataRoot }
	});
	backend.seed(hostUserDataRoot + '/ordinary.txt', Buffer.from('ordinary'));

	if (!hasWriter && backend.files !== undefined) {
		const { write: _write, ...files } = backend.files;

		Object.assign(backend, {
			capabilities: {
				...backend.capabilities,
				operations: backend.capabilities.operations.filter(
					(operation) => operation !== 'files.write'
				)
			},
			files
		});
	}

	const verification = verifyCredentialExclusion(
		{
			...original,
			provider: {
				...original.provider,
				profiles: { open: [backend.profile], copy: [] },
				open: ({ hostUserDataRoots }) =>
					Promise.resolve(
						hostUserDataRoots === undefined
							? backend
							: Object.assign(backend, { hostUserDataRoots })
					)
			},
			async createFixture(selection) {
				const selected = await original.createFixture(selection);
				const home = homedir();

				backend.beforeWrite = async (target, bytes) => {
					if (
						affected !== undefined &&
						target === hostUserDataRoot + '/' + affected
					) {
						await writeFile(path.join(home, affected), bytes);

						if (failure === 'accepted') {
							return;
						}
					}

					throw new SandboxPermissionDeniedError({ operation: 'writeFile' });
				};

				return {
					...selected,
					policy,
					verifyDisposed(opened, recovery) {
						expect({ opened, recovery }).toStrictEqual({
							opened: backend,
							recovery: { kind: 'none' }
						});

						return Promise.resolve();
					}
				};
			}
		},
		{ mode: 'open', profile: backend.profile },
		'~/.ssh'
	);

	if (failure !== undefined) {
		await expect(verification).rejects.toThrow(
			failure === 'accepted'
				? 'instead of rejecting'
				: 'The host markers must keep their original contents.'
		);

		return;
	}

	await verification;

	expect(backend.calls).toStrictEqual([
		{ operation: 'readFile', path: hostUserDataRoot + '/ordinary.txt' },
		{ operation: 'readFile', path: hostUserDataRoot + '/.ssh' },
		{ operation: 'readFile', path: hostUserDataRoot + '/alias.txt' },
		...(hasWriter
			? [
					{ operation: 'writeFile', path: hostUserDataRoot + '/ordinary.txt' },
					{ operation: 'writeFile', path: hostUserDataRoot + '/.ssh' },
					{ operation: 'writeFile', path: hostUserDataRoot + '/alias.txt' }
				]
			: [])
	]);
});

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
					workspace: {
						root: '/fixture/workspace',
						pathFlavor: 'posix' as const,
						relationship: 'shared' as const,
						description: 'In-memory fixture',
						hostUserDataRoot: '/fixture/host-user-data'
					},
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

it.each([
	{ policyMode: 'implicit', access: 'read', isConfigured: false },
	{ policyMode: 'read-only', access: 'read', isConfigured: false },
	{ policyMode: 'read-write', access: 'write', isConfigured: false },
	{ policyMode: 'read-write', access: 'write', isConfigured: true }
] as const)(
	'scopes $access with $policyMode host user data (configured root: $isConfigured)',
	async ({ policyMode, access, isConfigured }) => {
		const allowedDirectory = await mkdtemp(path.join(tmpdir(), 'byos-root-'));
		const checkout = await mkdtemp(path.join(tmpdir(), 'byos-workspace-'));
		const root = await realpath(allowedDirectory);
		const filename = path.join(root, 'file');
		const selected: Profile = {
			...profile,
			policy: {
				...profile.policy,
				hostUserData: policyMode === 'implicit' ? 'read-only' : policyMode
			}
		};
		const attempt: FixtureAttempt = {};
		const rootsSeen: boolean[] = [];
		const settings = {
			...(policyMode !== 'implicit' && { policy: selected.policy }),
			...(isConfigured && { readRoots: [allowedDirectory] })
		};
		const runtime = await fixtureBroker(
			{
				id: 'fixture.roots',
				label: 'Read roots fixture',
				profiles: { open: [selected], copy: [] },
				validateConfig: () => ({}),
				open(request) {
					rootsSeen.push(request.hostUserDataRoots?.includes(root) === true);

					const backend = new MemoryBackend('exec');

					return Promise.resolve(
						Object.assign(backend, {
							policy: selected.policy,
							workspace: {
								...backend.workspace,
								hostUserDataRoot: '/target-home'
							},
							...(request.hostUserDataRoots !== undefined && {
								hostUserDataRoots: request.hostUserDataRoots
							}),
							grantedPaths: [
								{ hostPath: filename, targetPath: filename, kind: access }
							]
						})
					);
				}
			},
			checkout,
			{},
			settings,
			attempt
		);

		try {
			const options = { access: { paths: { [access]: [filename] } } };
			const result = await runtime.negotiate(options);

			if (!isConfigured) {
				expect({ result, attempt, rootsSeen }).toMatchObject({
					result: {
						ok: false,
						error: {
							name: 'UnsupportedSandboxPolicyError',
							detail: { kind: 'path', access, path: filename, reason: 'limit' }
						}
					},
					attempt: {},
					rootsSeen: []
				});

				return;
			}

			const sandbox = await runtime.acquire(options, 'open');

			expect({ result, rootsSeen, grants: sandbox.grantedPaths }).toStrictEqual(
				{
					result: { ok: true, profile: selected },
					rootsSeen: [true],
					grants: [{ kind: access, hostPath: filename, targetPath: filename }]
				}
			);
		} finally {
			await runtime.close();
			await rm(allowedDirectory, { recursive: true, force: true });
			await rm(checkout, { recursive: true, force: true });
		}
	}
);

it.each([
	{ mode: 'open', echo: 'missing' },
	{ mode: 'copy', echo: 'different' }
] as const)(
	'disposes the $mode backend whose host user data roots echo is $echo',
	async ({ mode, echo }) => {
		const openProfile: Profile = {
			...profile,
			capabilities: [...profile.capabilities, 'copy']
		};
		const copyProfile: Profile = {
			...openProfile,
			policy: { ...openProfile.policy, hostWorkspaceWrites: false }
		};
		const selected = mode === 'open' ? openProfile : copyProfile;
		const disposals: string[] = [];
		const allocate = () => {
			const backend = new MemoryBackend('exec');

			return Promise.resolve(
				Object.assign(backend, {
					policy: selected.policy,
					capabilities: {
						...backend.capabilities,
						operations: selected.capabilities
					},
					workspace: {
						...backend.workspace,
						relationship:
							mode === 'copy' ? ('copied' as const) : ('shared' as const),
						hostUserDataRoot: '/target-home'
					},
					...(echo === 'different' && { hostUserDataRoots: ['/different'] }),
					dispose() {
						disposals.push(mode);

						return Promise.resolve();
					}
				})
			);
		};

		const runtime = await fixtureBroker(
			{
				id: 'fixture.echo',
				label: 'Read roots echo fixture',
				profiles: { open: [openProfile], copy: [copyProfile] },
				validateConfig: () => ({}),
				open: allocate,
				copy: allocate
			},
			await realpath(tmpdir()),
			{},
			{},
			{}
		);

		try {
			await expect(runtime.acquire({}, mode)).rejects.toMatchObject({
				name: 'InvalidSandboxDeclarationError',
				detail: { kind: 'declaration', field: 'hostUserDataRoots' }
			});
			expect(disposals).toStrictEqual([mode]);
		} finally {
			await runtime.close();
		}
	}
);
