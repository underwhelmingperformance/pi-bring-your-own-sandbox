import { fileURLToPath } from 'node:url';

import { createSandboxClient } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { withPiRuntime } from '../../sdk/src/fixtures/pi-runtime.js';

import { createSandboxGuard } from './guard.js';

it.each(['..', '../dist/extension.js'])(
	'loads the standalone guard through Pi: %s',
	async (entry) => {
		const outcomes: string[] = [];

		await withPiRuntime(
			[
				{
					name: 'consumer',
					factory(pi) {
						const client = createSandboxClient(pi, import.meta.filename);

						pi.on('session_start', async (_event, context) => {
							await expect(client.get(context)).rejects.toMatchObject({
								name: 'SandboxProviderRequiredError'
							});
							outcomes.push('provider required');
						});
					}
				}
			],
			(runtime, errors) => {
				const runner = runtime.session.extensionRunner;

				expect({
					errors,
					outcomes,
					tools: runner.getAllRegisteredTools(),
					commands: runner.getRegisteredCommands()
				}).toStrictEqual({
					errors: [],
					outcomes: ['provider required'],
					tools: [],
					commands: []
				});

				return Promise.resolve();
			},
			{
				additionalExtensionPaths: [
					fileURLToPath(new URL(entry, import.meta.url))
				],
				bindFixtureSources: false
			}
		);
	}
);

it('exports a configurable extension factory', () => {
	expect(
		typeof createSandboxGuard(import.meta.filename, {
			providerId: 'expected',
			terminationScope: 'workload',
			exitStatus: 'guaranteed'
		})
	).toBe('function');
});
