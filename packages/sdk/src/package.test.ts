import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
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
		typeof result.filename !== 'string' ||
		typeof result.version !== 'string' ||
		!Array.isArray(result.files)
	) {
		throw new Error('pnpm pack did not report the archive and packed files.');
	}

	return {
		filename: result.filename,
		version: result.version,
		paths: result.files
			.map((file: unknown) => {
				if (!isRecord(file) || typeof file.path !== 'string') {
					throw new Error('pnpm pack reported an invalid file path.');
				}

				return file.path;
			})
			.toSorted((left, right) => left.localeCompare(right))
	};
}

it.skipIf(process.env.BYOS_PACKAGE_TESTS !== '1')(
	'clean tarball installs (pnpm test:package installs isolated dependency roots)',
	async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-package-'));
		const host = path.join(directory, 'host');
		const provider = path.join(directory, 'provider');
		const artifacts = path.join(directory, 'artifacts');
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
				dependencies: manifest.dependencies,
				peers: manifest.peerDependencies,
				optional: manifest.peerDependenciesMeta,
				pi: manifest.pi,
				exports: manifest.exports
			}).toStrictEqual({
				dependencies: undefined,
				peers: {
					'@earendil-works/pi-coding-agent': '1.5.0',
					typebox: '1.3.27',
					vitest: '5.0.5'
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
				pi: guardManifest.pi,
				exports: guardManifest.exports,
				dependencies: guardManifest.dependencies
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
				['typescript@6.0.3', '@types/node@24.12.2', 'typebox@1.3.27'],
				true
			);
			await run(host, 'pnpm', ['exec', 'tsc']);
			await run(host, process.execPath, ['check.js']);
			await run(host, 'pnpm', ['exec', 'tsc', '--noEmit']);
			await add(
				provider,
				['vitest@5.0.5', 'typescript@6.0.3', '@types/node@24.12.2'],
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
