import { execFile } from 'node:child_process';
import {
	copyFile,
	mkdir,
	mkdtemp,
	readFile,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';

import {
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { isRecord } from './validation.js';

const execute = promisify(execFile);

it
	.skipIf(process.env.BYOS_PACKAGE_TESTS !== '1')
	.each(['production clone', 'Git dependency'])(
	'loads the committed source SDK and consumer through a %s',
	async (installation) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-source-'));
		const repository = fileURLToPath(new URL('..', import.meta.url));
		const consumer = path.join(directory, 'consumer');
		const sdk = path.join(
			consumer,
			'node_modules',
			'pi-bring-your-own-sandbox'
		);
		const run = (
			cwd: string,
			executable: string,
			arguments_: readonly string[]
		) =>
			execute(executable, arguments_, {
				cwd,
				env: {
					...process.env,
					npm_config_cache: path.join(directory, 'npm-cache')
				},
				timeout: 120_000
			});
		const install = [
			'install',
			'--omit=dev',
			'--legacy-peer-deps',
			'--no-audit',
			'--no-fund'
		];

		try {
			const { stdout } = await run(repository, 'git', ['rev-parse', 'HEAD']);
			const revision = stdout.trim();

			await mkdir(consumer);
			await writeFile(
				path.join(consumer, 'package.json'),
				JSON.stringify({
					name: 'byos-source-consumer',
					version: '0.0.0',
					private: true,
					type: 'module'
				})
			);

			if (installation === 'production clone') {
				await mkdir(path.dirname(sdk), { recursive: true });
				await run(directory, 'git', [
					'clone',
					'--no-checkout',
					repository,
					sdk
				]);
				await run(sdk, 'git', ['checkout', '--detach', revision]);
				await run(sdk, 'npm', install);
			} else {
				await run(consumer, 'npm', [
					...install,
					`git+${pathToFileURL(repository).href}#${revision}`
				]);
				await expect(
					stat(path.join(sdk, 'src/fixtures'))
				).rejects.toMatchObject({ code: 'ENOENT' });
			}

			for (const filename of ['index.ts', 'extension.ts', 'workspace.ts']) {
				await copyFile(
					path.join(sdk, 'examples/consumer/src', filename),
					path.join(consumer, filename)
				);
			}

			await expect(stat(path.join(sdk, 'dist'))).rejects.toMatchObject({
				code: 'ENOENT'
			});

			const manifest: unknown = JSON.parse(
				await readFile(path.join(sdk, 'package.json'), 'utf8')
			);

			if (!isRecord(manifest)) {
				throw new Error('The installed source manifest must be an object.');
			}

			expect(manifest.exports).toStrictEqual(
				Object.fromEntries(
					['api', 'extension', 'pi-tools', 'testing'].map((entry) => [
						`./${entry}`,
						{ types: `./src/${entry}.ts`, import: `./src/${entry}.ts` }
					])
				)
			);

			const loader = new DefaultResourceLoader({
				cwd: directory,
				agentDir: path.join(directory, 'agent'),
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [sdk, path.join(consumer, 'index.ts')],
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true
			});

			await loader.reload();

			const result = loader.getExtensions();

			expect({
				errors: result.errors,
				tools: result.extensions.flatMap((extension) =>
					extension.tools.keys().toArray()
				),
				commands: result.extensions.flatMap((extension) =>
					extension.commands.keys().toArray()
				)
			}).toStrictEqual({
				errors: [],
				tools: ['sandbox_pwd'],
				commands: ['byos']
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	180_000
);
