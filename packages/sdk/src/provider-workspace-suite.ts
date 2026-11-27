import { execFile } from 'node:child_process';
import { realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect } from 'vitest';

import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';
import type {
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';

export async function verifyWorkspaceCase<Config>(
	options: SandboxProviderTestOptions<Config>,
	scenario: 'special' | 'read-grant',
	selection?: SandboxProviderTestSelection
): Promise<void> {
	const fixture = await options.createFixture(selection);

	try {
		const provider = fixture.provider ?? options.provider;
		const attempt: FixtureAttempt = {};

		if (scenario === 'special') {
			const filename = path.join(
				fixture.hostWorkspace,
				'.byos-conformance-fifo'
			);

			await promisify(execFile)('mkfifo', [filename]);
		}

		const runtime = await fixtureBroker(
			provider,
			fixture.hostWorkspace,
			fixture.configuration,
			{ policy: fixture.policy },
			attempt
		);

		try {
			const timeoutMs = options.timeoutMs ?? 10_000;

			if (selection !== undefined) {
				expect(await runtime.negotiate({ timeoutMs })).toStrictEqual({
					ok: true,
					profile: selection.profile
				});
			}

			if (scenario === 'special') {
				await expect(
					runtime.acquire({ timeoutMs }, 'open')
				).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError'
				});
				expect(attempt.backend).toBeUndefined();

				return;
			}

			const filename = '.byos-conformance-read-grant';
			const contents = new TextEncoder().encode('workspace grant');
			const hostPath = path.join(fixture.hostWorkspace, filename);

			await writeFile(hostPath, contents, { flag: 'wx' });

			const canonical = await realpath(hostPath);
			const sandbox = await runtime.acquire(
				{
					timeoutMs,
					access: { paths: { read: [hostPath] } }
				},
				'open'
			);
			const target = path[sandbox.workspace.pathFlavor].join(
				sandbox.workspace.root,
				filename
			);

			if (selection !== undefined) {
				expect(attempt.backend?.profile).toStrictEqual(selection.profile);
			}

			expect(sandbox.grantedPaths).toStrictEqual([
				{ kind: 'read', hostPath: canonical, targetPath: target }
			]);

			if (sandbox.capabilities.operations.includes('files.read')) {
				expect(await sandbox.files.readFile(target)).toStrictEqual(contents);
			}
		} finally {
			expect(await runtime.close()).toStrictEqual({
				confirmed: true,
				failures: [],
				recoveries: []
			});

			if (attempt.backend !== undefined || attempt.recovery !== undefined) {
				await bounded(
					options,
					() => fixture.verifyDisposed(attempt.backend, attempt.recovery),
					'dispose'
				);
			}
		}
	} finally {
		await bounded(options, () => fixture.cleanup());
	}
}
