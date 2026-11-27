import {
	cp,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { afterAll, beforeAll, expect, it } from 'vitest';

import {
	add,
	packedArchive,
	project,
	retainedReleaseArchive,
	run
} from '../../../test-support/packages.js';

import type * as build from './compute-protocol-build.js';
import type * as consumer from './consumer.js';
import type {
	ProcessRequest,
	SandboxAcquireOptions,
	SandboxHost
} from './contracts.js';
import type * as discovery from './discovery.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { fixtureProfiles } from './fixtures/profile-fixture.js';
import { PROTOCOL_MAJOR } from './protocol-envelope.js';
import type * as provider from './provider.js';
import { isRecord } from './validation.js';

const sdk = fileURLToPath(new URL('../', import.meta.url));
const packageName = 'pi-bring-your-own-sandbox';
const isPackageRun = process.env['BYOS_PACKAGE_TESTS'] === '1';
const packageFixture: {
	installed?: readonly [string, string];
	directory?: string;
} = {};
const capability = 'fixture-trace' as NonNullable<
	SandboxAcquireOptions['capabilities']
>[number];

beforeAll(async () => {
	if (!isPackageRun) {
		return;
	}

	const directory = await mkdtemp(
		path.join(tmpdir(), 'byos-packaged-protocol-')
	);

	packageFixture.directory = directory;

	let archive = retainedReleaseArchive(packageName);

	if (archive === undefined) {
		await run(sdk, 'pnpm', ['build']);

		const result = await run(sdk, 'pnpm', [
			'pack',
			'--ignore-scripts',
			'--json',
			'--pack-destination',
			directory
		]);

		archive = packedArchive(result.stdout).filename;
	}

	const tarball = archive;
	const install = async (name: string) => {
		const prefix = path.join(directory, name);

		await project(prefix);
		await add(prefix, [tarball]);

		return realpath(path.join(prefix, 'node_modules', packageName));
	};

	packageFixture.installed = await Promise.all([
		install('first'),
		install('second')
	]);
}, 120_000);

afterAll(async () => {
	if (packageFixture.directory !== undefined) {
		await rm(packageFixture.directory, { recursive: true, force: true });
	}
});

function installedPackages(): readonly [string, string] {
	const { installed } = packageFixture;

	if (installed === undefined) {
		throw new Error('The release archive is missing from the package fixture.');
	}

	return installed;
}

it.skipIf(!isPackageRun)(
	'matches the frozen registry in the installed release',
	async () => {
		const [root] = installedPackages();
		const inputs = (await import(
			pathToFileURL(path.join(root, 'dist/protocol-payloads.js')).href
		)) as typeof import('./protocol-payloads.js');
		const { protocolSnapshot } = (await import(
			pathToFileURL(path.join(root, 'dist/protocol-snapshot.js')).href
		)) as typeof import('./protocol-snapshot.js');
		const frozen: unknown = JSON.parse(
			await readFile(
				new URL('fixtures/protocol-snapshots/1.0.json', import.meta.url),
				'utf8'
			)
		);

		expect(protocolSnapshot(1, 0, inputs.protocolSchemas)).toStrictEqual(
			frozen
		);
	}
);

it.skipIf(!isPackageRun).each([
	{ reverse: false, providerIndex: 0 },
	{ reverse: true, providerIndex: 0 },
	{ reverse: false, providerIndex: 1 },
	{ reverse: true, providerIndex: 1 }
] as const)(
	'starts two independently installed releases and runs Pi Bash (%j)',
	async ({ reverse, providerIndex }) => {
		const roots = installedPackages();
		const [first, second] = await Promise.all([
			loadPeer(path.join(roots[0], 'dist'), 'first', 0, 1),
			loadPeer(path.join(roots[1], 'dist'), 'second', 0, 1)
		]);
		const peers = [first, second] as const;
		const providerPeer = peers[providerIndex];
		const template = new MemoryBackend('exec');
		const workspace = { ...template.workspace, defaultShell: 'sh' as const };
		const profile = {
			...template.profile,
			processKinds: ['shell'] as const,
			shells: ['sh'] as const
		};
		const acquired: string[] = [];
		const requests: ProcessRequest[] = [];
		const providerId = 'fixture.release-provider';

		const extensions: InlineExtension[] = peers.map((peer) => ({
			name: peer.name,
			factory(pi) {
				const client = peer.consumers.createSandboxClient(pi, peer.name);

				if (peer === providerPeer) {
					peer.providers.registerSandboxProvider(pi, peer.name, {
						id: providerId,
						label: 'Packaged release fixture',
						profiles: { open: [profile], copy: [] },
						create: () => ({
							configure: () => ({ configuration: undefined }),
							open: ({ profile }) =>
								Promise.resolve({
									id: template.id,
									workspace,
									policyDescription: template.policyDescription,
									recovery: template.recovery,
									profile,
									exec(request, context) {
										requests.push(request);
										context.onOutput({
											stream: 'stdout',
											data: Buffer.from('packaged process')
										});

										return Promise.resolve({
											kind: 'exited',
											exit: { kind: 'code', code: 0 }
										});
									},
									dispose: () => Promise.resolve()
								})
						})
					});
				} else {
					peer.tools.default(pi, peer.name);
				}

				pi.on('session_start', async (_event, context) => {
					const sandbox = await client.get(context);

					acquired.push(sandbox.providerId);
				});
			}
		}));

		await withPiRuntime(
			reverse ? extensions.toReversed() : extensions,
			async (runtime, errors) => {
				const command = 'release check';
				const event = await runtime.session.extensionRunner.emitUserBash({
					type: 'user_bash',
					command,
					excludeFromContext: false,
					cwd: runtime.session.sessionManager.getCwd()
				});

				if (event?.operations === undefined) {
					throw new Error(
						'The release did not supply Pi user-shell operations.'
					);
				}

				const result = await runtime.session.executeBash(command, undefined, {
					operations: event.operations
				});

				expect({
					errors,
					acquired,
					result,
					requests,
					versions: peers.map(({ packageVersion }) => packageVersion),
					isSameFactory:
						first.consumers.createSandboxClient ===
						second.consumers.createSandboxClient,
					isSameBuild: first.buildId === second.buildId
				}).toStrictEqual({
					errors: [],
					acquired: [providerId, providerId],
					result: {
						output: 'packaged process',
						exitCode: 0,
						cancelled: false,
						truncated: false,
						fullOutputPath: undefined
					},
					requests: [
						{
							kind: 'shell',
							dialect: 'sh',
							command,
							cwd: template.workspace.root
						}
					],
					versions: ['1.0.0', '1.0.0'],
					isSameFactory: false,
					isSameBuild: true
				});
			},
			{ bindFixtureSources: false }
		);
	}
);

it.skipIf(!isPackageRun)(
	'closes an owned copy when the installed adapter rejects its handle',
	async () => {
		const [root] = installedPackages();
		const { checkedCopy } = (await import(
			pathToFileURL(path.join(root, 'dist/sandbox-copy.js')).href
		)) as typeof import('./sandbox-copy.js');
		const resources = new Set(['owned-copy']);

		await expect(
			checkedCopy(
				{
					sandbox: { backendId: 'owned-copy' },
					close() {
						resources.delete('owned-copy');

						return Promise.resolve({
							confirmed: true,
							failures: [],
							recoveries: []
						});
					}
				},
				{},
				import.meta.filename
			)
		).rejects.toMatchObject({
			name: 'InvalidSandboxDeclarationError',
			detail: { kind: 'declaration', field: 'copy' }
		});
		expect(resources).toStrictEqual(new Set());
	}
);

async function rewrite(file: string, from: string, to: string): Promise<void> {
	const source = await readFile(file, 'utf8');

	expect(source).toContain(from);
	await writeFile(
		file,
		source.replace(from, () => to)
	);
}

async function writeProtocolBuild(distribution: string) {
	const module = (await import(
		pathToFileURL(path.join(distribution, 'compute-protocol-build.js')).href
	)) as typeof build;
	const identity = module.computeProtocolBuild();

	await writeFile(
		path.join(distribution, 'protocol-build.json'),
		JSON.stringify(identity) + '\n'
	);

	return identity;
}

async function loadBuild(
	root: string,
	name: string,
	featureLevel: 0 | 1,
	major = PROTOCOL_MAJOR
) {
	const directory = path.join(root, name);
	const distribution = path.join(directory, 'dist');
	const { installed } = packageFixture;
	const source = installed?.[featureLevel] ?? sdk;

	await cp(path.join(source, 'dist'), distribution, { recursive: true });
	await cp(
		path.join(source, 'package.json'),
		path.join(directory, 'package.json')
	);
	await symlink(
		installed === undefined
			? path.join(sdk, 'node_modules')
			: path.dirname(source),
		path.join(directory, 'node_modules')
	);

	const envelope = path.join(distribution, 'protocol-envelope.js');

	if (featureLevel === 1) {
		await rewrite(
			envelope,
			'PROTOCOL_FEATURE_LEVEL = 0',
			'PROTOCOL_FEATURE_LEVEL = 1'
		);

		const schemas = path.join(distribution, 'schemas.js');

		await rewrite(
			schemas,
			"Type.Literal('search.grep')",
			"Type.Literal('search.grep'), Type.With(Type.Literal('fixture-trace'), { 'x-byos-feature-level': 1 })"
		);
	}

	if (major !== PROTOCOL_MAJOR) {
		await rewrite(
			envelope,
			`PROTOCOL_MAJOR = ${String(PROTOCOL_MAJOR)}`,
			`PROTOCOL_MAJOR = ${String(major)}`
		);
	}

	if (major !== PROTOCOL_MAJOR || featureLevel > 0) {
		await writeProtocolBuild(distribution);
	}

	return loadPeer(distribution, name, featureLevel, major);
}

async function loadPeer(
	distribution: string,
	name: string,
	featureLevel: number,
	major: number
) {
	const metadata = (await import(
		pathToFileURL(path.join(distribution, 'protocol-build.js')).href
	)) as typeof import('./protocol-build.js');

	const consumers = (await import(
		pathToFileURL(path.join(distribution, 'consumer.js')).href
	)) as typeof consumer;
	const providers = (await import(
		pathToFileURL(path.join(distribution, 'provider.js')).href
	)) as typeof provider;
	const internals = (await import(
		pathToFileURL(path.join(distribution, 'discovery.js')).href
	)) as typeof discovery;
	const tools = (await import(
		pathToFileURL(path.join(distribution, 'pi-tools.js')).href
	)) as typeof import('./pi-tools.js');

	return {
		consumers,
		providers,
		discovery: internals,
		tools,
		name,
		featureLevel,
		major,
		...metadata.protocolBuild()
	};
}

it.each([
	{ reverse: false, providerLevel: 0 },
	{ reverse: true, providerLevel: 0 },
	{ reverse: false, providerLevel: 1 },
	{ reverse: true, providerLevel: 1 }
] as const)(
	'exchanges demands and offers across two compiled builds (%j)',
	async ({ reverse, providerLevel }) => {
		const root = await mkdtemp(path.join(tmpdir(), 'pi-byos-compat-'));

		try {
			const old = await loadBuild(root, 'release', 0);
			const current = await loadBuild(root, 'next', 1);
			const provider = providerLevel === 0 ? old : current;
			const template = new MemoryBackend();
			const operations = [
				...template.capabilities.operations,
				...(providerLevel === 1 ? [capability] : [])
			];
			const outcomes: unknown[] = [];

			const extensions: InlineExtension[] = [old, current].map((sdkCopy) => ({
				name: sdkCopy.name,
				factory(pi: SandboxHost) {
					const client = sdkCopy.consumers.createSandboxClient(
						pi,
						sdkCopy.name
					);

					if (sdkCopy === provider) {
						sdkCopy.providers.registerSandboxProvider(pi, sdkCopy.name, {
							id: 'fixture',

							label: 'Fixture',
							profiles: fixtureProfiles(
								{ ...template.capabilities, operations },
								{
									hostWorkspaceWrites: [true],
									hostUserData: ['denied'],
									hostSystemFiles: ['read-only'],
									network: [false]
								}
							),

							create: () => ({
								configure: () => ({ configuration: undefined }),
								open: (request) => {
									const backend = new MemoryBackend();

									Object.defineProperty(backend, 'profile', {
										value: request.profile
									});

									return Promise.resolve(backend);
								}
							})
						});
					}

					pi.on('session_start', async (_event, context) => {
						const broker = sdkCopy.discovery.discoverBroker(pi.events);
						const status = await broker?.status(context);
						const providers = await broker?.providers(context);
						const sandbox = await client.get(context);

						outcomes.push({
							extension: sdkCopy.name,
							protocol: status?.protocol,
							provider: sandbox.providerId,
							hasNewCapability:
								sandbox.profile.capabilities.includes(capability),
							hasNewOffer: providers
								?.find((entry) => entry.id === 'fixture')
								?.profiles.open.some((profile) =>
									profile.capabilities.includes(capability)
								)
						});

						if (sdkCopy !== current) {
							return;
						}

						const demand = client.get(context, { capabilities: [capability] });

						if (providerLevel === 0) {
							await expect(demand).rejects.toThrow(
								`Update release (build ${old.buildId})`
							);

							return;
						}

						const resolved = await demand;

						expect(resolved.providerId).toBe('fixture');
					});
				}
			}));

			await withPiRuntime(
				reverse ? extensions.toReversed() : extensions,
				(_runtime, errors) => {
					const protocol = {
						buildId: current.buildId,
						packageVersion: current.packageVersion,
						extensionSource: current.name,
						featureLevel: 1,
						major: PROTOCOL_MAJOR
					};

					expect({
						errors,
						outcomes: outcomes.toSorted((a, b) =>
							JSON.stringify(a).localeCompare(JSON.stringify(b))
						)
					}).toStrictEqual({
						errors: [],
						outcomes: [
							{
								extension: current.name,
								protocol,
								provider: 'fixture',
								hasNewCapability: providerLevel === 1,
								hasNewOffer: providerLevel === 1
							},
							{
								extension: old.name,
								protocol,
								provider: 'fixture',
								hasNewCapability: false,
								hasNewOffer: false
							}
						]
					});

					return Promise.resolve();
				},
				{ bindFixtureSources: false }
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);

const describe = (sdkCopy: Awaited<ReturnType<typeof loadBuild>>) =>
	`major ${String(sdkCopy.major)} from ${sdkCopy.name} (build ${sdkCopy.buildId})`;

it('reports both compiled builds when the census sees a future protocol major', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'pi-byos-compat-'));

	try {
		const [first, second] = await Promise.all([
			loadBuild(root, 'first', 0),
			loadBuild(root, 'second', 0, PROTOCOL_MAJOR + 1)
		]);
		const identities = [first, second];

		await withPiRuntime(
			identities.map((sdkCopy) => ({
				name: sdkCopy.name,
				factory(pi) {
					sdkCopy.consumers.createSandboxClient(pi, sdkCopy.name);
				}
			})),
			(_runtime, errors) => {
				const a = describe(first);
				const b = describe(second);

				expect(
					errors.map((error) => (isRecord(error) ? error['error'] : undefined))
				).toStrictEqual([
					`Protocol ${a} is incompatible with ${b}. Update the extensions together.`,
					`Protocol ${b} is incompatible with ${a}. Update the extensions together.`
				]);

				return Promise.resolve();
			},
			{ bindFixtureSources: false }
		);
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

it('changes the build ID when the code changes within one schema and package release', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'pi-byos-compat-'));

	try {
		const [first, second] = await Promise.all([
			loadBuild(root, 'before', 0),
			loadBuild(root, 'after', 0)
		]);

		expect(first.buildId).toBe(second.buildId);

		const consumerFile = path.join(root, second.name, 'dist/consumer.js');
		const source = await readFile(consumerFile, 'utf8');

		await writeFile(
			consumerFile,
			source + '\nexport const fixtureChange = true;\n'
		);

		const changed = await writeProtocolBuild(
			path.join(root, second.name, 'dist')
		);

		expect(changed).toStrictEqual({
			packageVersion: first.packageVersion,
			buildId: expect.any(String) as unknown
		});
		expect(changed).not.toStrictEqual({
			packageVersion: first.packageVersion,
			buildId: first.buildId
		});
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});
