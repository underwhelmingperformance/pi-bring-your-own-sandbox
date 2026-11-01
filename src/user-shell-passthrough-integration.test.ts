import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { withPiRuntime } from './fixtures/pi-runtime.js';
import { registerUserShell } from './user-shell.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

it('runs an unconfigured Pi user shell through default passthrough', async () => {
	await withPiRuntime(
		[{ name: 'user-shell', factory: registerUserShell }],
		async (runtime, errors) => {
			const command = "printf 'unconfigured user shell'";
			const event = await runtime.session.extensionRunner.emitUserBash({
				type: 'user_bash',
				command,
				excludeFromContext: false,
				cwd: runtime.session.sessionManager.getCwd()
			});

			if (event?.operations === undefined) {
				throw new Error('The adapter did not provide user-shell operations.');
			}

			const result = await runtime.session.executeBash(command, undefined, {
				operations: event.operations
			});

			expect({ errors, result }).toStrictEqual({
				errors: [],
				result: {
					output: 'unconfigured user shell',
					exitCode: 0,
					cancelled: false,
					truncated: false,
					fullOutputPath: undefined
				}
			});
		},
		{
			prepare(directory) {
				vi.stubEnv('PI_CODING_AGENT_DIR', path.join(directory, 'agent'));
			}
		}
	);
});
