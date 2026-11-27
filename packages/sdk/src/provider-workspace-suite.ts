import { execFile } from 'node:child_process';
import { readFile, realpath, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect } from 'vitest';

import { isWithinLimit } from './profile-negotiation.js';
import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';
import type {
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';

export async function verifyWorkspaceCase<Config>(
	options: SandboxProviderTestOptions<Config>,
	scenario: 'special' | 'read-grant' | 'write-grant',
	selection?: SandboxProviderTestSelection
): Promise<void> {
	const fixture = await options.createFixture(selection);

	try {
		const provider = fixture.provider ?? options.provider;
		const openProfiles =
			selection === undefined ? provider.profiles.open : [selection.profile];
		const attempt: FixtureAttempt = {};

		if (scenario === 'special') {
			const filename = path.join(
				fixture.hostWorkspace,
				'.byos-conformance-fifo'
			);

			await promisify(execFile)('mkfifo', [filename]);
		}

		const runtime = await fixtureBroker(
			{ ...provider, profiles: { ...provider.profiles, open: openProfiles } },
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

			const kind = scenario === 'write-grant' ? 'write' : 'read';
			const filename = `.byos-conformance-${kind}-grant`;
			const contents = new TextEncoder().encode('workspace grant');
			const hostPath = path.join(fixture.hostWorkspace, filename);

			await writeFile(hostPath, contents, { flag: 'wx' });

			const canonical = await realpath(hostPath);
			const request = {
				timeoutMs,
				access: { paths: { [kind]: [kind === 'write' ? filename : hostPath] } }
			};
			const canGrant = kind === 'read' || fixture.policy.hostWorkspaceWrites;
			const hasProbe = openProfiles.some(
				({ capabilities, policy }) =>
					(kind === 'read' || policy.hostWorkspaceWrites) &&
					isWithinLimit(policy, fixture.policy) &&
					capabilities.includes(`files.${kind}`)
			);

			if (!canGrant || !hasProbe) {
				await expect(runtime.acquire(request, 'open')).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError',
					detail: {
						kind: 'path',
						access: kind,
						path: canonical,
						reason: canGrant ? 'profile' : 'limit'
					}
				});
				expect(attempt).toStrictEqual({});

				return;
			}

			const sandbox = await runtime.acquire(request, 'open');
			const target = path[sandbox.workspace.pathFlavor].join(
				sandbox.workspace.root,
				filename
			);

			if (selection !== undefined) {
				expect(attempt.backend?.profile).toStrictEqual(selection.profile);
			}

			expect(sandbox.grantedPaths).toStrictEqual([
				{ kind, hostPath: canonical, targetPath: target }
			]);

			if (kind === 'read') {
				expect(await sandbox.files.readFile(target)).toStrictEqual(contents);

				return;
			}

			const replacement = 'updated through workspace write grant';

			await sandbox.files.writeFile(target, Buffer.from(replacement));
			expect(await readFile(hostPath, 'utf8')).toBe(replacement);
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
