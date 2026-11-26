import {
	cp,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import type { InlineExtension } from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import type * as consumer from './consumer.js';
import type { SandboxAcquireOptions, SandboxHost } from './contracts.js';
import type * as discovery from './discovery.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { withPiRuntime } from './fixtures/pi-runtime.js';
import { fixtureProfiles } from './fixtures/profile-fixture.js';
import type * as build from './protocol-build.js';
import type * as provider from './provider.js';
import { isRecord } from './validation.js';

const sdk = fileURLToPath(new URL('../', import.meta.url));
const capability = 'fixture-trace' as NonNullable<
	SandboxAcquireOptions['capabilities']
>[number];

async function rewrite(file: string, from: string, to: string): Promise<void> {
	const source = await readFile(file, 'utf8');

	expect(source).toContain(from);
	await writeFile(
		file,
		source.replace(from, () => to)
	);
}

async function loadBuild(
	root: string,
	name: string,
	featureLevel: 0 | 1,
	major = 1
) {
	const directory = path.join(root, name);
	const distribution = path.join(directory, 'dist');

	await cp(path.join(sdk, 'dist'), distribution, { recursive: true });
	await cp(
		path.join(sdk, 'package.json'),
		path.join(directory, 'package.json')
	);
	await symlink(
		path.join(sdk, 'node_modules'),
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
			"import { Compile } from 'typebox/compile';",
			"import { Compile } from 'typebox/compile';\nimport { introducedAt } from './protocol-schema.js';"
		);
		await rewrite(
			schemas,
			"Type.Literal('copy')",
			"Type.Literal('copy'), introducedAt(1, Type.Literal('fixture-trace'))"
		);
	}

	if (major !== 1) {
		await rewrite(
			envelope,
			'PROTOCOL_MAJOR = 1',
			`PROTOCOL_MAJOR = ${String(major)}`
		);
	}

	const buildModule = (await import(
		pathToFileURL(path.join(distribution, 'protocol-build.js')).href
	)) as typeof build;

	buildModule.writeProtocolBuild();

	const consumers = (await import(
		pathToFileURL(path.join(distribution, 'consumer.js')).href
	)) as typeof consumer;
	const providers = (await import(
		pathToFileURL(path.join(distribution, 'provider.js')).href
	)) as typeof provider;
	const internals = (await import(
		pathToFileURL(path.join(distribution, 'discovery.js')).href
	)) as typeof discovery;

	return {
		consumers,
		providers,
		discovery: internals,
		name,
		featureLevel,
		major,
		...buildModule.protocolBuild()
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

							validateConfig: () => ({}),
							open: (request) => {
								const backend = new MemoryBackend();

								Object.defineProperty(backend, 'profile', {
									value: request.profile
								});

								return Promise.resolve(backend);
							}
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
								sandbox.capabilities.operations.includes(capability),
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
						major: 1
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

it('reports both compiled builds when their protocol majors disagree', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'pi-byos-compat-'));

	try {
		const [first, second] = await Promise.all([
			loadBuild(root, 'first', 0),
			loadBuild(root, 'second', 0, 2)
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

		const location = path.join(root, second.name, 'dist/protocol-build.js');
		const writer = (await import(pathToFileURL(location).href)) as typeof build;

		writer.writeProtocolBuild();

		const metadata = path.join(root, second.name, 'dist/protocol-build.json');
		const changed: unknown = JSON.parse(await readFile(metadata, 'utf8'));

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
