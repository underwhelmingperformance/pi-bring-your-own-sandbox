import assert from 'node:assert/strict';
import {
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	SandboxPolicy,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/provider';
import {
	registerSandboxProvider,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/provider';
import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';

import { provider, state } from './provider.js';

const policy: SandboxPolicy = {
	hostWorkspaceWrites: false,
	network: false,
	hostUserData: 'denied',
	hostSystemFiles: 'read-only'
};

const contractProvider = {
	...provider,
	profiles: {
		...provider.profiles,
		open: provider.profiles.open.filter(
			(profile) => !profile.policy.hostWorkspaceWrites
		)
	},
	create: () => ({
		...provider.create(),
		configure: () => ({ configuration: undefined, settings: { policy } }),
		async open(request, context) {
			const entries = await readdir(request.hostWorkspace, {
				withFileTypes: true
			});

			if (entries.some((entry) => entry.isFIFO())) {
				throw new UnsupportedSandboxPolicyError({ operation: 'open' });
			}

			const backend = await provider.create().open(request, context);
			const grantedPaths = request.paths?.read?.map((hostPath) => ({
				kind: 'read' as const,
				hostPath,
				targetPath: path.posix.join(
					backend.workspace.root,
					path.basename(hostPath)
				)
			}));

			return {
				...backend,
				...(grantedPaths !== undefined && { grantedPaths }),
				async exec(invocation, execution) {
					if (
						invocation.kind !== 'argv' ||
						invocation.executable !== 'read-source'
					) {
						return backend.exec(invocation, execution);
					}

					execution.onOutput({
						stream: 'stdout',
						data: await readFile(path.join(request.hostWorkspace, 'source'))
					});

					return { kind: 'exited', exit: { kind: 'code', code: 0 } };
				}
			};
		}
	})
} satisfies SandboxProvider<undefined>;

defineSandboxProviderTests({
	verifyRecoveryAfterCancellation: true,
	policyEffects: ['read-only'],
	label: 'installed provider using its own Vitest peer',
	provider: contractProvider,
	async createFixture() {
		assert.equal(state.isRunning, false);
		state.sample = 'original';
		state.opens = 0;
		state.disposals = 0;
		state.calls.length = 0;

		const directory = await mkdtemp(
			path.join(tmpdir(), 'byos-packed-contract-')
		);
		const workspace = await realpath(directory);
		const source = path.join(workspace, 'source');
		const temporary = path.join(workspace, 'replacement');

		await writeFile(source, 'original');

		return {
			configuration: undefined,
			hostWorkspace: workspace,
			policy,
			register(pi, extensionSource) {
				registerSandboxProvider(pi, extensionSource, contractProvider);
			},
			verifyPolicy(backend) {
				assert.equal(backend.profile.policy.hostWorkspaceWrites, false);

				return Promise.resolve();
			},
			visibility: {
				targetPath: 'source',
				readSource: () => readFile(source),
				async replaceSource(bytes) {
					await writeFile(temporary, bytes);
					await rename(temporary, source);
				},
				readTarget: { kind: 'argv', executable: 'read-source', args: [] },
				writeTarget: () => ({
					kind: 'argv',
					executable: 'replace-sample',
					args: []
				})
			},
			policyEffects: {
				'read-only': () =>
					Promise.resolve({
						permitted: {
							request: { kind: 'argv', executable: 'pwd', args: [] },
							exit: { kind: 'code', code: 0 },
							stdout: new TextEncoder().encode('/packed/project\n'),
							stderr: new Uint8Array()
						},
						denied: {
							request: { kind: 'argv', executable: 'replace-sample', args: [] },
							exit: { kind: 'code', code: 1 },
							stdout: new Uint8Array(),
							stderr: new Uint8Array()
						},
						observe: () =>
							Promise.resolve({
								kind: 'file',
								content: Buffer.from(state.sample),
								mode: 0o444,
								links: 1
							})
					})
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
				after: {
					request: { kind: 'argv', executable: 'pwd', args: [] },
					exit: { kind: 'code', code: 0 },
					stdout: new TextEncoder().encode('/packed/project\n'),
					stderr: new Uint8Array()
				},
				ready: new TextEncoder().encode('ready'),
				verifyStopped() {
					assert.equal(state.isRunning, false);

					return Promise.resolve();
				}
			},
			verifyDisposed(backend) {
				const expected = backend === undefined ? 0 : 1;

				assert.deepEqual(
					{
						opens: state.opens,
						disposals: state.disposals,
						isRunning: state.isRunning
					},
					{ opens: expected, disposals: expected, isRunning: false }
				);

				return Promise.resolve();
			},
			cleanup: () => rm(workspace, { recursive: true, force: true })
		};
	}
});
