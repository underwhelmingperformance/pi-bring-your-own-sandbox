import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect } from 'vitest';

import { isSandboxError, UnsupportedSandboxCapabilityError } from './errors.js';
import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';
import type {
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';

function isAccessDenied(error: unknown): boolean {
	return (
		error instanceof Error &&
		['SandboxPathNotFoundError', 'SandboxPermissionDeniedError'].includes(
			error.name
		)
	);
}

export async function verifyCredentialExclusion<Config>(
	options: SandboxProviderTestOptions<Config>,
	selection: SandboxProviderTestSelection,
	location: string
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-credential-home-'));
	const home = await realpath(directory);
	const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
	const previousHome = process.env[homeKey];

	try {
		process.env[homeKey] = home;

		const relative = location.slice(2);
		const credential = path.join(home, relative);
		const ordinary = path.join(home, 'ordinary.txt');
		const alias = path.join(home, 'alias.txt');

		await mkdir(path.dirname(credential), { recursive: true });
		await writeFile(ordinary, 'ordinary');
		await writeFile(credential, 'synthetic credential');
		await symlink(credential, alias, 'file');

		const fixture = await options.createFixture(selection);

		try {
			const provider = fixture.provider ?? options.provider;
			const attempt: FixtureAttempt = {};
			const runtime = await fixtureBroker(
				provider,
				fixture.hostWorkspace,
				fixture.configuration,
				{ policy: fixture.policy, readRoots: ['~'] },
				attempt
			);

			try {
				const timeoutMs = options.timeoutMs ?? 10_000;

				for (const entry of [credential, alias]) {
					await expect(
						runtime.acquire(
							{
								timeoutMs,
								access: { paths: { read: [entry] } }
							},
							selection.mode
						)
					).rejects.toMatchObject({
						name: 'UnsupportedSandboxPolicyError',
						detail: {
							kind: 'path',
							access: 'read',
							path: credential,
							reason: 'limit'
						}
					});
				}

				expect(attempt).toStrictEqual({});

				const sandbox = await runtime.acquire({ timeoutMs }, selection.mode);
				const hostUserDataRoot = sandbox.workspace.hostUserDataRoot;

				if (hostUserDataRoot === undefined) {
					throw new Error(
						'The provider must specify where host user data appears in the target.'
					);
				}

				const flavor = path[sandbox.workspace.pathFlavor];
				const allowed = flavor.join(hostUserDataRoot, 'ordinary.txt');
				const read = await sandbox.files.readFile(allowed);

				expect(Buffer.from(read).toString('utf8')).toBe('ordinary');

				const excluded = [relative, 'alias.txt'].map((entry) =>
					flavor.join(hostUserDataRoot, entry)
				);

				for (const target of excluded) {
					await expect(sandbox.files.readFile(target)).rejects.toSatisfy(
						isAccessDenied
					);
				}

				const isReadOnly =
					selection.profile.policy.hostUserData === 'read-only';
				const canWriteFiles =
					sandbox.capabilities.operations.includes('files.write');
				const isWriteRefused =
					isReadOnly && !canWriteFiles
						? (error: unknown) =>
								isSandboxError(error, UnsupportedSandboxCapabilityError)
						: isAccessDenied;

				const writeTargets = isReadOnly ? [allowed, ...excluded] : excluded;

				for (const target of writeTargets) {
					await expect(
						sandbox.files.writeFile(target, Buffer.from('changed'))
					).rejects.toSatisfy(isWriteRefused);
				}

				expect(
					await Promise.all([
						readFile(ordinary, 'utf8'),
						readFile(credential, 'utf8')
					]),
					'The host markers must keep their original contents.'
				).toStrictEqual(['ordinary', 'synthetic credential']);
			} finally {
				expect(await runtime.close()).toStrictEqual({
					confirmed: true,
					failures: [],
					recoveries: []
				});

				if (attempt.backend !== undefined) {
					await bounded(
						options,
						() =>
							fixture.verifyDisposed(
								attempt.backend,
								attempt.recovery ?? attempt.backend?.recovery
							),
						'dispose'
					);
				}
			}
		} finally {
			await bounded(options, () => fixture.cleanup());
		}
	} finally {
		if (previousHome === undefined) {
			Reflect.deleteProperty(process.env, homeKey);
		} else {
			process.env[homeKey] = previousHome;
		}

		await rm(home, { recursive: true, force: true });
	}
}
