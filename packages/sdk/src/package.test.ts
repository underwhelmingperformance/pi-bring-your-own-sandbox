import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { isRecord } from './validation.js';

const execute = promisify(execFile);

async function run(
	cwd: string,
	executable: string,
	arguments_: readonly string[]
) {
	try {
		return await execute(executable, arguments_, {
			cwd,
			env: { ...process.env, CI: 'true' },
			timeout: 120_000,
			maxBuffer: 8 * 1024 * 1024
		});
	} catch (error) {
		throw new Error(
			`Package verification failed: ${executable} ${arguments_.join(' ')}`,
			{ cause: error }
		);
	}
}

async function compilerPackage(): Promise<string> {
	const result = await run(process.cwd(), 'pnpm', ['exec', 'tsc', '--version']);
	const version = /^Version (\S+)$/.exec(result.stdout.trim())?.[1];

	if (version === undefined) {
		throw new Error('The project compiler did not report its version.');
	}

	return `typescript@${version}`;
}

async function project(directory: string, sdkOverride?: string) {
	await mkdir(directory);
	await writeFile(
		path.join(directory, 'package.json'),
		JSON.stringify({
			name: `byos-package-${path.basename(directory)}-fixture`,
			version: '0.0.0',
			private: true,
			type: 'module',
			packageManager: 'pnpm@12.15.0'
		})
	);

	if (sdkOverride !== undefined) {
		await writeFile(
			path.join(directory, 'pnpm-workspace.yaml'),
			`overrides:
  pi-bring-your-own-sandbox: ${JSON.stringify(`file:${sdkOverride}`)}
`
		);
	}

	await writeFile(
		path.join(directory, 'tsconfig.json'),
		JSON.stringify({
			compilerOptions: {
				target: 'ES2025',
				module: 'NodeNext',
				moduleResolution: 'NodeNext',
				strict: true,
				exactOptionalPropertyTypes: true,
				noUncheckedIndexedAccess: true,
				noPropertyAccessFromIndexSignature: true,
				skipLibCheck: true,
				types: ['node']
			},
			include: ['*.ts', 'workspace/.pi/extensions/**/*.ts']
		})
	);
}

async function add(
	directory: string,
	packages: readonly string[],
	isDevelopment = false
) {
	await run(directory, 'pnpm', [
		'add',
		...(isDevelopment ? ['--save-dev'] : []),
		...packages,
		'--ignore-scripts',
		'--strict-peer-dependencies',
		'--package-import-method=copy',
		'--prefer-offline'
	]);
}

interface PackedArchive {
	readonly filename: string;
	readonly version: string;
	readonly paths: readonly string[];
}

function packedArchive(output: string): PackedArchive {
	const result: unknown = JSON.parse(output);

	if (
		!isRecord(result) ||
		typeof result['filename'] !== 'string' ||
		typeof result['version'] !== 'string' ||
		!Array.isArray(result['files'])
	) {
		throw new Error('pnpm pack did not report the archive and packed files.');
	}

	return {
		filename: result['filename'],
		version: result['version'],
		paths: result['files']
			.map((file: unknown) => {
				if (!isRecord(file) || typeof file['path'] !== 'string') {
					throw new Error('pnpm pack reported an invalid file path.');
				}

				return file['path'];
			})
			.toSorted((left, right) => left.localeCompare(right))
	};
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
				'--dry-run',
				'--json'
			]);
			const preview = packedArchive(dryRun.stdout).paths;

			expect(preview).not.toContain(obsolete.split(path.sep).join('/'));

			const packed = await run(process.cwd(), 'pnpm', [
				'pack',
				'--json',
				'--pack-destination',
				artifacts
			]);
			const archive = packedArchive(packed.stdout);
			const paths = archive.paths;

			expect(paths).toStrictEqual(preview);
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

			for (const subpath of ['api', 'pi-tools', 'testing']) {
				expect(paths).toContain(`dist/${subpath}.js`);
				expect(paths).toContain(`dist/${subpath}.d.ts`);
				expect(paths).toContain(`src/${subpath}.ts`);
			}

			const guardRoot = path.resolve('../guard');

			await run(guardRoot, 'pnpm', ['build']);

			const guardPacked = await run(guardRoot, 'pnpm', [
				'pack',
				'--json',
				'--pack-destination',
				artifacts
			]);
			const guardTarball = packedArchive(guardPacked.stdout).filename;

			await project(host, tarball);
			await project(provider);
			await add(host, [
				guardTarball,
				tarball,
				'@earendil-works/pi-coding-agent@1.5.0',
				'@earendil-works/pi-ai@1.5.0'
			]);
			await add(provider, [tarball]);

			const installed = path.join(
				host,
				'node_modules/pi-bring-your-own-sandbox'
			);
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
				dependencies: undefined,
				peers: {
					'@earendil-works/pi-coding-agent': '1.5.0',
					typebox: '1.3.27',
					vitest: '5.0.5 || 5.1.0'
				},
				optional: { vitest: { optional: true } },
				pi: undefined,
				exports: Object.fromEntries(
					['api', 'pi-tools', 'testing'].map((entry) => [
						`./${entry}`,
						{ types: `./dist/${entry}.d.ts`, import: `./dist/${entry}.js` }
					])
				)
			});

			const guardManifest: unknown = JSON.parse(
				await readFile(
					path.join(
						host,
						'node_modules/pi-bring-your-own-sandbox-guard/package.json'
					),
					'utf8'
				)
			);

			if (!isRecord(guardManifest)) {
				throw new Error('The installed guard manifest must be an object.');
			}

			expect({
				pi: guardManifest['pi'],
				exports: guardManifest['exports'],
				dependencies: guardManifest['dependencies']
			}).toStrictEqual({
				pi: { extensions: ['./src/extension.ts'] },
				exports: {
					'.': { types: './dist/index.d.ts', import: './dist/index.js' }
				},
				dependencies: { 'pi-bring-your-own-sandbox': `^${archive.version}` }
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

			expect(result).toMatchObject({
				success: true,
				numTotalTests: 4,
				numPassedTests: 4,
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
	'installed source exports compile with strict consumer settings',
	async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'pi-byos-source-package-')
		);
		const consumer = path.join(directory, 'consumer');
		const compiler = await compilerPackage();

		try {
			const packed = await run(process.cwd(), 'pnpm', [
				'pack',
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

			await copyFile(
				new URL('../package.json', import.meta.url),
				path.join(installed, 'package.json')
			);
			await rm(path.join(installed, 'dist'), { recursive: true, force: true });
			await writeFile(
				path.join(consumer, 'consumer.ts'),
				[
					"export { getSandbox } from 'pi-bring-your-own-sandbox/api';",
					"export { default as sandboxTools } from 'pi-bring-your-own-sandbox/pi-tools';",
					"export { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';"
				].join('\n')
			);

			const source = await realpath(installed);
			const entrypoints = ['api', 'pi-tools', 'testing']
				.map((entry) => path.join(source, 'src', `${entry}.ts`))
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
