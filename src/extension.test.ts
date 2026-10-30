import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

it.each(['extension.ts', '../dist/extension.js'])(
	'loads the diagnostic command through the Pi extension loader: %s',
	async (extensionPath) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-'));

		try {
			const loader = new DefaultResourceLoader({
				cwd: directory,
				agentDir: path.join(directory, 'agent'),
				settingsManager: SettingsManager.inMemory(),
				additionalExtensionPaths: [
					fileURLToPath(new URL(extensionPath, import.meta.url))
				],
				noExtensions: true,
				noSkills: true,
				noThemes: true,
				noPromptTemplates: true,
				noContextFiles: true
			});

			await loader.reload();

			const result = loader.getExtensions();
			const commands = result.extensions.flatMap((extension) =>
				[...extension.commands].map(([name, command]) => ({
					name,
					description: command.description
				}))
			);

			expect({ errors: result.errors, commands }).toStrictEqual({
				errors: [],
				commands: [
					{
						name: 'byos',
						description: 'Show the sandbox framework scaffold status'
					}
				]
			});
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	}
);
