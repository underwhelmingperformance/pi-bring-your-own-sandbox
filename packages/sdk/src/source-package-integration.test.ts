import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

import { isRecord } from './validation.js';

it('loads the workspace source package and consumer through Pi', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-source-'));
	const sdk = fileURLToPath(new URL('..', import.meta.url));

	try {
		const manifest: unknown = JSON.parse(
			await readFile(path.join(sdk, 'package.json'), 'utf8')
		);

		if (!isRecord(manifest)) {
			throw new TypeError('The SDK manifest must be an object.');
		}

		expect(manifest.exports).toStrictEqual(
			Object.fromEntries(
				['api', 'pi-tools', 'testing'].map((entry) => [
					`./${entry}`,
					{ types: `./src/${entry}.ts`, import: `./src/${entry}.ts` }
				])
			)
		);

		const loader = new DefaultResourceLoader({
			cwd: directory,
			agentDir: path.join(directory, 'agent'),
			settingsManager: SettingsManager.inMemory(),
			additionalExtensionPaths: [
				path.join(sdk, 'examples/consumer/src/index.ts')
			],
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
			commands: []
		});
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
