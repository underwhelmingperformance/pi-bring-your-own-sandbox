import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import {
	DefaultResourceLoader,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { expect, it } from 'vitest';

async function load(extensionPath: string) {
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
		return loader.getExtensions();
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it.each(['extension.ts', '../dist/extension.js'])(
	'loads diagnostics through the Pi extension loader: %s',
	async (extensionPath) => {
		const result = await load(extensionPath);
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
					description: 'Show sandbox status or available providers'
				}
			]
		});
	}
);

it.each(['pi-tools.ts', '../dist/pi-tools.js'])(
	'loads only the supported shell definitions through Pi: %s',
	async (extensionPath) => {
		const result = await load(extensionPath);
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
			tools: ['bash', 'powershell'],
			commands: []
		});
	}
);
