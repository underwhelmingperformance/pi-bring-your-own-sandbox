import { execFile } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import {
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

const execute = promisify(execFile);

it.skipIf(process.env.BYOS_PACKAGE_TESTS !== '1')(
	'loads a source-only SDK and consumer after a production install without peers',
	async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-source-'));
		const consumer = path.join(directory, 'consumer');
		const sdk = path.join(
			consumer,
			'node_modules',
			'pi-bring-your-own-sandbox'
		);

		try {
			await mkdir(sdk, { recursive: true });
			await cp(
				new URL('../package.json', import.meta.url),
				path.join(sdk, 'package.json')
			);
			await cp(new URL('.', import.meta.url), path.join(sdk, 'src'), {
				recursive: true
			});
			await cp(
				new URL('../examples/consumer/src/', import.meta.url),
				consumer,
				{
					recursive: true
				}
			);
			await execute(
				'npm',
				[
					'install',
					'--omit=dev',
					'--legacy-peer-deps',
					'--no-audit',
					'--no-fund'
				],
				{
					cwd: sdk,
					env: {
						...process.env,
						npm_config_cache: path.join(directory, 'npm-cache')
					},
					timeout: 120_000
				}
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
