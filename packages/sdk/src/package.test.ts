import { randomUUID } from 'node:crypto';
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { expect, it } from 'vitest';

import {
	add,
	compilerPackage,
	packedArchive,
	project,
	run
} from '../../../test-support/packages.js';

import { isRecord } from './validation.js';

async function assertNodeEntryPoints(directory: string): Promise<void> {
	const entryPoints = [
		'consumer',
		'host',
		'pi-tools',
		'provider',
		'provider-kit',
		'review',
		'testing'
	];
	const plainNode = await run(directory, process.execPath, [
		'--input-type=module',
		'-e',
		`const entries = ${JSON.stringify(entryPoints)};
for (const entry of entries) {
  const specifier = 'pi-bring-your-own-sandbox/' + entry;
  await import(specifier);
  const filename = import.meta.resolve(specifier);
  if (!filename.includes('/dist/') || !filename.endsWith('.js')) throw new Error(filename);
}
process.stdout.write(JSON.stringify(entries));`
	]);

	expect(JSON.parse(plainNode.stdout)).toStrictEqual(entryPoints);
}

it.skipIf(process.env['BYOS_PACKAGE_TESTS'] !== '1').each(['5.0.5', '5.1.0'])(
	'clean tarball installs with Vitest %s (pnpm test:package installs isolated dependency roots)',
	async (vitestVersion) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-package-'));
		const host = path.join(directory, 'host');
		const provider = path.join(directory, 'provider');
		const artifacts = path.join(directory, 'artifacts');
		const compiler = await compilerPackage();
		const obsolete = path.join(
			'dist',
			`obsolete-package-test-${randomUUID()}.js`
		);

		try {
			await mkdir(artifacts);
			await mkdir('dist', { recursive: true });
			await writeFile(obsolete, 'export {};\n');
			await run(process.cwd(), 'pnpm', ['build']);

			const dryRun = await run(process.cwd(), 'pnpm', [
				'pack',
				'--ignore-scripts',
				'--dry-run',
				'--json'
			]);
			const preview = packedArchive(dryRun.stdout).paths;

			expect(preview).not.toContain(obsolete.split(path.sep).join('/'));

			const packed = await run(process.cwd(), 'pnpm', [
				'pack',
				'--ignore-scripts',
				'--json',
				'--pack-destination',
				artifacts
			]);
			const archive = packedArchive(packed.stdout);
			const paths = archive.paths;

			expect(paths).toStrictEqual(preview);
			expect(
				paths.filter(
					(file) =>
						file.startsWith('examples/docker/') || file.startsWith('src/')
				)
			).toStrictEqual([]);
			expect(
				paths.filter((file) =>
					/(?:^|\/)(?:node_modules|src\/fixtures|\.git|\.env[^/]*|coverage)(?:\/|$)|\.test\.|(?:^|\/)tsconfig[^/]*\.json$|pnpm-lock\.yaml$/.test(
						file
					)
				)
			).toStrictEqual([]);

			const tarball = archive.filename;
			const contents = await run(directory, 'tar', ['-tzf', tarball]);

			expect(
				contents.stdout
					.trim()
					.split('\n')
					.map((file) => file.replace(/^package\//, ''))
					.toSorted((left, right) => left.localeCompare(right))
			).toStrictEqual(paths);

			for (const subpath of [
				'consumer',
				'host',
				'pi-tools',
				'provider',
				'provider-kit',
				'review',
				'testing'
			]) {
				const entry = subpath === 'host' ? 'embedding-host' : subpath;

				expect(paths).toContain(`dist/${entry}.js`);
				expect(paths).toContain(`dist/${entry}.d.ts`);
			}

			await project(host, tarball);
			await project(provider);
			await add(host, [
				tarball,
				'@earendil-works/pi-coding-agent@1.5.0',
				'@earendil-works/pi-ai@1.5.0'
			]);
			await add(provider, [tarball]);

			const installed = path.join(
				host,
				'node_modules/pi-bring-your-own-sandbox'
			);
			const license = await readFile(path.join(installed, 'LICENSE'), 'utf8');

			expect(license).toContain('Copyright (c) 2017-present, Jon Schlinkert.');

			const manifest: unknown = JSON.parse(
				await readFile(path.join(installed, 'package.json'), 'utf8')
			);

			expect(isRecord(manifest)).toBe(true);

			if (!isRecord(manifest)) {
				throw new Error('The installed manifest must be an object.');
			}

			expect({
				dependencies: manifest['dependencies'],
				peers: manifest['peerDependencies'],
				optional: manifest['peerDependenciesMeta'],
				pi: manifest['pi'],
				exports: manifest['exports']
			}).toStrictEqual({
				dependencies: { ignore: '7.0.14', picomatch: '4.0.7', re2js: '2.10.0' },
				peers: {
					'@earendil-works/pi-ai': '1.5.0',
					'@earendil-works/pi-coding-agent': '1.5.0',
					typebox: '1.3.27',
					vitest: '5.0.5 || 5.1.0'
				},
				optional: { vitest: { optional: true } },
				pi: undefined,
				exports: Object.fromEntries(
					[
						'consumer',
						'host',
						'pi-tools',
						'provider',
						'provider-kit',
						'review',
						'testing'
					].map((entry) => [
						`./${entry}`,
						{
							types: `./dist/${entry === 'host' ? 'embedding-host' : entry}.d.ts`,
							import: `./dist/${entry === 'host' ? 'embedding-host' : entry}.js`
						}
					])
				)
			});

			const declarations = await readFile(
				path.join(installed, 'dist/contracts.d.ts'),
				'utf8'
			);

			expect(declarations).toContain(
				'Cancellation and deadline settings for one consumer call.'
			);
			await copyFile(
				new URL('fixtures/package/host/check.ts', import.meta.url),
				path.join(host, 'check.ts')
			);
			await copyFile(
				new URL('fixtures/package/provider/provider.ts', import.meta.url),
				path.join(provider, 'provider.ts')
			);
			await add(
				host,
				[compiler, '@types/node@24.12.2', 'typebox@1.3.27'],
				true
			);
			await run(host, 'pnpm', ['exec', 'tsc']);
			await run(host, process.execPath, ['check.js']);
			await run(host, 'pnpm', ['exec', 'tsc', '--noEmit']);
			await add(host, ['typebox@1.3.27', `vitest@${vitestVersion}`]);

			await assertNodeEntryPoints(host);

			await add(
				provider,
				[`vitest@${vitestVersion}`, compiler, '@types/node@24.12.2'],
				true
			);
			await copyFile(
				new URL('fixtures/package/provider/contract.ts', import.meta.url),
				path.join(provider, 'contract.test.ts')
			);
			await run(provider, 'pnpm', ['exec', 'tsc', '--noEmit']);

			const report = path.join(provider, 'report.json');

			await run(provider, 'pnpm', [
				'exec',
				'vitest',
				'run',
				'--reporter=default',
				'--reporter=json',
				'--outputFile',
				report
			]);

			const result: unknown = JSON.parse(await readFile(report, 'utf8'));
			const contractCases = [
				'uses the shipped provider registration and preset settings',
				'open profile 1: checks credential read grant eligibility',
				'open profile 1: checks credential write grant eligibility',
				'open profile 1: workspace visibility (shared)',
				'open profile 1: checks a workspace read grant',
				...(process.platform === 'win32'
					? []
					: ['open profile 1: refuses a workspace with a special file'])
			];

			expect(result).toMatchObject({
				success: true,
				numTotalTests: 8 + contractCases.length,
				numPassedTests: 8 + contractCases.length,
				testResults: [
					{
						assertionResults: expect.arrayContaining([
							expect.objectContaining({
								title:
									'open profile 1: confirmed cancellation and continued use',
								status: 'passed'
							}),
							expect.objectContaining({
								title: 'open profile 1: policy effects (read-only)',
								status: 'passed'
							}),
							...contractCases.map((title): unknown =>
								expect.objectContaining({ title, status: 'passed' })
							)
						]) as unknown
					}
				],
				numPendingTests: 0
			});
		} finally {
			await rm(obsolete, { force: true });
			await rm(directory, { recursive: true, force: true });
		}
	},
	300_000
);

it.skipIf(process.env['BYOS_PACKAGE_TESTS'] !== '1')(
	'installed declarations compile with strict consumer settings',
	async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-source-package-')
		);
		const consumer = path.join(directory, 'consumer');
		const compiler = await compilerPackage();

		try {
			const packed = await run(process.cwd(), 'pnpm', [
				'pack',
				'--ignore-scripts',
				'--json',
				'--pack-destination',
				directory
			]);

			await project(consumer);
			await add(consumer, [packedArchive(packed.stdout).filename]);
			await add(
				consumer,
				[compiler, '@types/node@24.12.2', 'vitest@5.0.5'],
				true
			);

			const installed = path.join(
				consumer,
				'node_modules/pi-bring-your-own-sandbox'
			);

			await writeFile(
				path.join(consumer, 'consumer.ts'),
				[
					"export { createSandboxClient } from 'pi-bring-your-own-sandbox/consumer';",
					"export type { SandboxErrorInfo, SandboxNegotiation, SandboxRequirements } from 'pi-bring-your-own-sandbox/consumer';",
					"export type { DestinationDescription, EscalationDestination, ReviewUnavailableReason } from 'pi-bring-your-own-sandbox/review';",
					"export { initialiseSandboxHost } from 'pi-bring-your-own-sandbox/host';",
					"export { registerSandboxProvider } from 'pi-bring-your-own-sandbox/provider';",
					"export { ShellTransportRunner } from 'pi-bring-your-own-sandbox/provider-kit';",
					"export { default as sandboxTools } from 'pi-bring-your-own-sandbox/pi-tools';",
					"export { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';"
				].join('\n')
			);

			const installRoot = await realpath(installed);
			const entrypoints = [
				'consumer',
				'host',
				'pi-tools',
				'provider',
				'provider-kit',
				'review',
				'testing'
			]
				.map((entry) =>
					path.join(
						installRoot,
						'dist',
						`${entry === 'host' ? 'embedding-host' : entry}.d.ts`
					)
				)
				.toSorted((left, right) => left.localeCompare(right));
			const checked = await run(consumer, 'pnpm', [
				'exec',
				'tsc',
				'--noEmit',
				'--listFiles'
			]);

			expect(
				checked.stdout
					.split(/\r?\n/)
					.map((file) => path.normalize(file))
					.filter((file) => entrypoints.includes(file))
					.toSorted((left, right) => left.localeCompare(right))
			).toStrictEqual(entrypoints);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	300_000
);

it.skipIf(process.env['BYOS_PACKAGE_TESTS'] !== '1')(
	'imports every SDK entry point from an installed Git subdirectory',
	async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-git-install-')
		);
		const consumer = path.join(directory, 'consumer');

		try {
			const [root, revision] = await Promise.all([
				run(process.cwd(), 'git', ['rev-parse', '--show-toplevel']),
				run(process.cwd(), 'git', ['rev-parse', 'HEAD'])
			]);
			const origin = pathToFileURL(root.stdout.trim()).href;
			const source = `git+${origin}#${revision.stdout.trim()}&path:/packages/sdk`;

			await project(consumer);
			await writeFile(
				path.join(consumer, 'pnpm-workspace.yaml'),
				[
					'allowBuilds:',
					`  ${JSON.stringify('pi-bring-your-own-sandbox@' + source)}: true`,
					"  '@google/genai': false",
					'  protobufjs: false',
					''
				].join('\n')
			);
			await run(consumer, 'pnpm', [
				'add',
				`pi-bring-your-own-sandbox@${source}`,
				'vitest@5.1.0',
				'--strict-peer-dependencies',
				'--prefer-offline'
			]);
			await assertNodeEntryPoints(consumer);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	180_000
);
