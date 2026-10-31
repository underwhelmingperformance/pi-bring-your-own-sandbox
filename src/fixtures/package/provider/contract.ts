import assert from 'node:assert/strict';

import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';

import { provider, state } from './provider.js';

defineSandboxProviderTests({
	label: 'installed provider using its own Vitest peer',
	provider,
	createFixture() {
		assert.equal(state.isRunning, false);
		state.opens = 0;
		state.disposals = 0;
		state.calls.length = 0;
		return Promise.resolve({
			configuration: {},
			hostWorkspace: process.cwd(),
			policy: {
				workspaceAccess: 'read-write',
				filesystemScope: 'provider-default',
				networkAccess: 'provider-default'
			},
			processes: [
				{
					request: { kind: 'argv', executable: 'pwd', args: [] },
					exit: { kind: 'code', code: 0 },
					stdout: new TextEncoder().encode('/packed/project\n'),
					stderr: new Uint8Array()
				}
			],
			cancellation: {
				request: { kind: 'argv', executable: 'wait', args: [] },
				ready: new TextEncoder().encode('ready'),
				verifyStopped() {
					assert.equal(state.isRunning, false);
					return Promise.resolve();
				}
			},
			verifyDisposed() {
				assert.deepEqual(
					{
						opens: state.opens,
						disposals: state.disposals,
						isRunning: state.isRunning
					},
					{ opens: 1, disposals: 1, isRunning: false }
				);
				return Promise.resolve();
			},
			cleanup: () => Promise.resolve()
		});
	}
});
