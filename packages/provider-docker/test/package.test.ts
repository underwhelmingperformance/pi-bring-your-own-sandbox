import {
	copyFile,
	cp,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import {
	add,
	packedArchive,
	project,
	run
} from '../../../test-support/packages.js';

const docker = fileURLToPath(new URL('../', import.meta.url));
const sdk = fileURLToPath(new URL('../../sdk/', import.meta.url));
const repository = fileURLToPath(new URL('../../../', import.meta.url));

async function withPackedProvider(
	verify: (consumer: string, installed: string) => Promise<void>
): Promise<void> {
	const directory = await mkdtemp(
		path.join(tmpdir(), 'pi-byos-packed-docker-')
	);
	const consumer = path.join(directory, 'consumer');

	try {
		const pack = async (cwd: string) => {
			const result = await run(cwd, 'pnpm', [
				'pack',
				'--json',
				'--pack-destination',
				directory
			]);

			return packedArchive(result.stdout).filename;
		};

		const [sdkArchive, dockerArchive] = await Promise.all([
			pack(sdk),
			pack(docker)
		]);

		await project(consumer, sdkArchive);
		await add(consumer, [
			sdkArchive,
			dockerArchive,
			'typebox@1.3.27',
			'vitest@5.1.0'
		]);
		await verify(
			consumer,
			path.join(consumer, 'node_modules/pi-byos-provider-docker')
		);
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it.skipIf(process.env['BYOS_PACKAGE_TESTS'] !== '1')(
	'loads the separately packed Docker extension with its bundled matcher',
	() =>
		withPackedProvider(async (consumer, installed) => {
			const plainNode = await run(consumer, process.execPath, [
				'--input-type=module',
				'-e',
				`const main = await import("pi-byos-provider-docker");
const shell = await import("pi-byos-provider-docker/shell-profile");
process.stdout.write(JSON.stringify([typeof main.default, typeof shell.default]));`
			]);

			expect(JSON.parse(plainNode.stdout)).toStrictEqual([
				'function',
				'function'
			]);

			expect(await readdir(installed)).not.toContain('src');

			const matcher = new URL(import.meta.resolve('re2js'));
			const assets = path.join(installed, 'dist');
			const packedMatcher = await Promise.all([
				readFile(path.join(assets, 're2js.mjs')),
				readFile(path.join(assets, 'RE2JS-LICENSE'))
			]);
			const originalMatcher = await Promise.all([
				readFile(matcher),
				readFile(new URL('../LICENSE', matcher))
			]);

			expect(packedMatcher).toStrictEqual(originalMatcher);

			const extension = path.join(consumer, '.pi/extensions/docker');

			await cp(assets, extension, { recursive: true });

			const copiedMatcher = await run(extension, process.execPath, [
				'--input-type=module',
				'-e',
				"import { readDockerMatcher } from './matcher.js'; process.stdout.write(await readDockerMatcher());"
			]);

			expect(copiedMatcher.stdout).toBe(await readFile(matcher, 'utf8'));

			const loader = new DefaultResourceLoader({
				cwd: consumer,
				agentDir: path.join(consumer, 'agent'),
				settingsManager: SettingsManager.inMemory(),
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true,
				additionalExtensionPaths: [path.join(installed, 'dist/index.js')]
			});

			await loader.reload();

			const loaded = loader.getExtensions();

			expect({
				errors: loaded.errors,
				tools: loaded.extensions.flatMap((item) => item.tools.keys().toArray()),
				commands: loaded.extensions.flatMap((item) =>
					item.commands.keys().toArray()
				)
			}).toStrictEqual({ errors: [], tools: [], commands: [] });
		}),
	180_000
);

it.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')(
	'checks copied workspace visibility through the installed Docker provider',
	() =>
		withPackedProvider(async (consumer, installed) => {
			const provider = 'packages/provider-docker';
			const checkout = path.join(consumer, provider);

			await mkdir(checkout, { recursive: true });
			await Promise.all([
				copyFile(
					path.join(installed, 'package.json'),
					path.join(checkout, 'package.json')
				),
				cp(path.join(installed, 'dist'), path.join(checkout, 'dist'), {
					recursive: true
				})
			]);

			for (const file of [
				provider + '/test/fixture.ts',
				provider + '/test/provider.test.ts',
				'test-support/remaining-budget.ts',
				'test-support/node-visibility-probe.ts'
			]) {
				const target = path.join(consumer, file);

				await mkdir(path.dirname(target), { recursive: true });

				const source = await readFile(path.join(repository, file), 'utf8');

				await writeFile(target, source.replaceAll('../src/', '../dist/'));
			}

			const report = path.join(consumer, 'docker-report.json');

			await run(consumer, 'pnpm', [
				'exec',
				'vitest',
				'run',
				provider + '/test/provider.test.ts',
				'-t',
				String.raw`workspace visibility \(copied\)`,
				'--reporter=json',
				'--outputFile',
				report
			]);

			const result: unknown = JSON.parse(await readFile(report, 'utf8'));

			expect(result).toMatchObject({
				success: true,
				numPassedTests: 1,
				numFailedTests: 0
			});
		}),
	180_000
);
