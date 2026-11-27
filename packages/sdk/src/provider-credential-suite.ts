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

const fixtureAgentPath = '.pi-conformance';

export const piCredentialProbePaths = [
	'~/' + fixtureAgentPath + '/auth.json',
	'~/' + fixtureAgentPath + '/mcp-auth.json'
];

async function withCredentialHome(
	run: (home: string, parent: string) => Promise<void>
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-credential-home-'));
	const root = await realpath(directory);
	const home = path.join(root, 'home');
	const homeKey = process.platform === 'win32' ? 'USERPROFILE' : 'HOME';
	const previousHome = process.env[homeKey];
	const previousAgent = process.env['PI_CODING_AGENT_DIR'];

	try {
		await mkdir(home);
		process.env[homeKey] = home;
		process.env['PI_CODING_AGENT_DIR'] = path.join(home, fixtureAgentPath);
		await run(home, root);
	} finally {
		for (const [key, value] of [
			[homeKey, previousHome],
			['PI_CODING_AGENT_DIR', previousAgent]
		] as const) {
			if (value === undefined) {
				Reflect.deleteProperty(process.env, key);
			} else {
				process.env[key] = value;
			}
		}

		await rm(directory, { recursive: true, force: true });
	}
}

export async function verifyCredentialGrant<Config>(
	options: SandboxProviderTestOptions<Config>,
	selection: SandboxProviderTestSelection,
	kind: 'read' | 'write'
): Promise<void> {
	await withCredentialHome(async (home) => {
		const file = path.join(home, '.ssh', 'probe');
		const original = 'synthetic credential';
		const changed = 'updated synthetic credential';

		await mkdir(path.dirname(file));
		await writeFile(file, original);

		const fixture = await options.createFixture(selection);
		const provider = fixture.provider ?? options.provider;
		const attempt: FixtureAttempt = {};

		try {
			const runtime = await fixtureBroker(
				{
					...provider,
					profiles: { ...provider.profiles, open: [selection.profile] }
				},
				fixture.hostWorkspace,
				fixture.configuration,
				{ policy: selection.profile.policy },
				attempt
			);

			try {
				const plan = await runtime.planEscalation({
					access: { paths: { [kind]: [file] } }
				});
				const canGrant =
					selection.profile.credentialPathGrantKinds?.includes(kind) ?? false;

				expect({ destination: plan.destination.kind, attempt }).toStrictEqual({
					destination: canGrant ? 'provider' : 'host',
					attempt: {}
				});

				if (!canGrant) {
					return;
				}

				const copy = await plan.open(runtime.context, {
					timeoutMs: options.timeoutMs ?? 10_000
				});

				try {
					const grant = copy.sandbox.grantedPaths?.find(
						(entry) => entry.kind === kind && entry.hostPath === file
					);

					if (grant === undefined) {
						throw new Error(
							'The provider did not report the requested credential grant.'
						);
					}

					if (kind === 'read') {
						const bytes = await copy.sandbox.files.readFile(grant.targetPath);

						expect(Buffer.from(bytes).toString('utf8')).toBe(original);
					} else {
						await copy.sandbox.files.writeFile(
							grant.targetPath,
							Buffer.from(changed)
						);
					}

					expect(await readFile(file, 'utf8')).toBe(
						kind === 'write' ? changed : original
					);
				} finally {
					expect(await copy.close()).toStrictEqual({
						confirmed: true,
						failures: [],
						recoveries: []
					});
				}
			} finally {
				await runtime.close();
				await bounded(options, () =>
					fixture.verifyDisposed(attempt.backend, attempt.recovery)
				);
			}
		} finally {
			await bounded(options, () => fixture.cleanup());
		}
	});
}

export async function verifyCredentialExclusion<Config>(
	options: SandboxProviderTestOptions<Config>,
	selection: SandboxProviderTestSelection,
	location: string
): Promise<void> {
	await withCredentialHome(async (home, parent) => {
		const relative = location.slice(2);
		const credential = path.join(home, relative);
		const ordinary = path.join(home, 'ordinary.txt');
		const alias = path.join(home, 'alias.txt');
		const outside = path.join(parent, 'outside.txt');

		await mkdir(path.dirname(credential), { recursive: true });
		await writeFile(ordinary, 'ordinary');
		await writeFile(outside, 'outside');
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

				await expect(
					runtime.acquire(
						{ timeoutMs, access: { paths: { read: [outside] } } },
						selection.mode
					)
				).rejects.toMatchObject({
					name: 'UnsupportedSandboxPolicyError',
					detail: { kind: 'path', access: 'read', path: outside }
				});
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
					sandbox.profile.capabilities.includes('files.write');
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
	});
}
