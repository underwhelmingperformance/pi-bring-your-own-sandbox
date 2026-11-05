import { fileURLToPath } from 'node:url';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import {
	DefaultResourceLoader,
	SessionManager,
	SettingsManager
} from '@earendil-works/pi-coding-agent';
import { closeSandboxSession, getSandbox } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { createSandboxGuard } from './guard.js';

it.each(['..', '../dist/extension.js'])(
	'loads the standalone guard through Pi: %s',
	async (entry) => {
		const state: { pi?: ExtensionAPI } = {};
		const loader = new DefaultResourceLoader({
			cwd: process.cwd(),
			agentDir: process.cwd(),
			settingsManager: SettingsManager.inMemory(),
			noExtensions: true,
			noSkills: true,
			noThemes: true,
			noPromptTemplates: true,
			noContextFiles: true,
			additionalExtensionPaths: [
				fileURLToPath(new URL(entry, import.meta.url))
			],
			extensionFactories: [
				{
					name: 'consumer',
					factory(pi) {
						state.pi = pi;
					}
				}
			]
		});

		await loader.reload();

		const loaded = loader.getExtensions();

		expect({
			errors: loaded.errors,
			tools: loaded.extensions.flatMap((extension) =>
				extension.tools.keys().toArray()
			),
			commands: loaded.extensions.flatMap((extension) =>
				extension.commands.keys().toArray()
			)
		}).toStrictEqual({ errors: [], tools: [], commands: [] });

		if (state.pi === undefined) {
			throw new Error('Pi did not load the consumer fixture.');
		}

		const context = {
			cwd: process.cwd(),
			sessionManager: SessionManager.inMemory(process.cwd())
		};

		try {
			await expect(getSandbox(state.pi, context)).rejects.toMatchObject({
				name: 'SandboxProviderRequiredError'
			});
		} finally {
			await closeSandboxSession(state.pi, context);
		}
	}
);

it('exports a configurable extension factory', () => {
	expect(
		typeof createSandboxGuard({
			providerId: 'expected',
			terminationScope: 'workload',
			exitStatus: 'guaranteed'
		})
	).toBe('function');
});
