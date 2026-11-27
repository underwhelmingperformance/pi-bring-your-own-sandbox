import {
	lstat,
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

import type { Sandbox, ShellDialect } from './contracts.js';
import { isSandboxError, UnsupportedSandboxCapabilityError } from './errors.js';
import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';
import type {
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';
import { encodePosixArgv } from './shell-transport.js';

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

const credentialFiles = new Set([
	'~/.netrc',
	'~/.git-credentials',
	'~/.docker/config.json',
	'~/.pypirc',
	'~/.cargo/credentials.toml',
	'~/.cargo/credentials',
	'~/.npmrc',
	'~/.gem/credentials',
	'~/.yarnrc.yml',
	'~/.terraform.d/credentials.tfrc.json',
	...piCredentialProbePaths
]);

const ordinaryMarker = 'ordinary';
const credentialMarker = 'synthetic credential';
const replacement = 'changed';

function credentialCommand(
	dialect: ShellDialect,
	target: string,
	kind: 'read' | 'write'
): string {
	if (dialect === 'powershell') {
		const filename = "'" + target.replaceAll("'", "''") + "'";

		return kind === 'read'
			? `[Console]::Write([IO.File]::ReadAllText(${filename}))`
			: `[IO.File]::WriteAllText(${filename}, '${replacement}')`;
	}

	const filename = encodePosixArgv([target]);

	return kind === 'read'
		? `value=''; { IFS= read -r value || [ -n "$value" ]; } < ${filename} && printf '%s' "$value"`
		: `${encodePosixArgv(['printf', '%s', replacement])} > ${filename}`;
}

async function verifyCredentialEffects(
	sandbox: Sandbox,
	allowed: string,
	excluded: readonly string[],
	excludedDirectories: readonly string[],
	timeoutMs: number
): Promise<void> {
	const { capabilities, policy, shells } = sandbox.profile;
	const flavor = path[sandbox.workspace.pathFlavor];
	const isReadOnly = policy.hostUserData === 'read-only';
	const writeTargets = isReadOnly ? [allowed, ...excluded] : excluded;
	const bytes = Buffer.from(replacement);
	const operation = { timeoutMs };

	if (capabilities.includes('files.read')) {
		await sandbox.files.access(allowed, 'read', operation);
		expect({
			bytes: Buffer.from(
				await sandbox.files.readFile(allowed, operation)
			).toString('utf8'),
			stat: await sandbox.files.stat(allowed, operation)
		}).toStrictEqual({
			bytes: ordinaryMarker,
			stat: { kind: 'file', size: ordinaryMarker.length }
		});

		for (const target of excluded) {
			await expect(sandbox.files.readFile(target, operation)).rejects.toSatisfy(
				isAccessDenied
			);
			await expect(
				sandbox.files.access(target, 'read', operation)
			).rejects.toSatisfy(isAccessDenied);
		}
	}

	if (capabilities.includes('files.list')) {
		expect(
			await sandbox.files.listDirectory(flavor.dirname(allowed), operation)
		).toContainEqual({
			name: flavor.basename(allowed),
			kind: 'file'
		});

		for (const directory of excludedDirectories) {
			let entries: Awaited<ReturnType<typeof sandbox.files.listDirectory>>;

			try {
				entries = await sandbox.files.listDirectory(directory, operation);
			} catch (error) {
				expect(error).toSatisfy(isAccessDenied);
				continue;
			}

			expect(entries.some(({ name }) => name === 'probe.txt')).toBe(false);
		}
	}

	if (capabilities.includes('files.write')) {
		for (const target of writeTargets) {
			await expect(
				sandbox.files.writeFile(target, bytes, operation)
			).rejects.toSatisfy(isAccessDenied);
			await expect(
				sandbox.files.access(target, 'write', operation)
			).rejects.toSatisfy(isAccessDenied);
		}

		for (const directory of excludedDirectories) {
			await expect(
				sandbox.files.mkdir(flavor.join(directory, 'new-directory'), operation)
			).rejects.toSatisfy(isAccessDenied);
		}
	} else if (isReadOnly) {
		await expect(
			sandbox.files.writeFile(allowed, bytes, operation)
		).rejects.toSatisfy((error: unknown) =>
			isSandboxError(error, UnsupportedSandboxCapabilityError)
		);
	}

	for (const dialect of shells) {
		async function run(target: string, kind: 'read' | 'write') {
			const result = await sandbox.exec(
				{
					kind: 'shell',
					dialect,
					command: credentialCommand(dialect, target, kind)
				},
				{ ...operation, maxCaptureBytes: 4096 }
			);

			return Buffer.from(result.stdout).toString('utf8');
		}

		expect(await run(allowed, 'read')).toBe(ordinaryMarker);

		for (const target of excluded) {
			expect(
				await run(target, 'read'),
				'The command exposed the synthetic credential.'
			).not.toContain(credentialMarker);
		}

		for (const target of writeTargets) {
			await run(target, 'write');
		}
	}
}

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
		const isDirectory = !credentialFiles.has(location);
		const suffix = isDirectory ? ['nested', 'probe.txt'] : [];
		const credential = path.join(home, relative, ...suffix);
		const credentialParent = path.dirname(credential);
		const ordinary = path.join(home, 'ordinary.txt');
		const alias = path.join(home, 'alias');
		const aliasMarker = path.join(alias, ...suffix);
		const outside = path.join(parent, 'outside.txt');

		await mkdir(credentialParent, { recursive: true });
		await writeFile(ordinary, ordinaryMarker);
		await writeFile(outside, 'outside');
		await writeFile(credential, credentialMarker);
		await symlink(
			path.join(home, relative),
			alias,
			isDirectory ? 'dir' : 'file'
		);

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

				for (const entry of [credential, aliasMarker]) {
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

				expect(sandbox.profile).toStrictEqual(selection.profile);

				if (hostUserDataRoot === undefined) {
					throw new Error(
						'The provider must specify where host user data appears in the target.'
					);
				}

				const flavor = path[sandbox.workspace.pathFlavor];
				const allowed = flavor.join(hostUserDataRoot, 'ordinary.txt');
				const excluded = [relative, 'alias'].map((entry) =>
					flavor.join(hostUserDataRoot, ...entry.split(path.sep), ...suffix)
				);
				const excludedDirectories = isDirectory
					? excluded.map((entry) => flavor.dirname(entry))
					: [];

				await verifyCredentialEffects(
					sandbox,
					allowed,
					excluded,
					excludedDirectories,
					timeoutMs
				);

				expect(
					await Promise.all([
						readFile(ordinary, 'utf8'),
						readFile(credential, 'utf8')
					]),
					'The host markers must keep their original contents.'
				).toStrictEqual([ordinaryMarker, credentialMarker]);

				if (isDirectory) {
					await expect(
						lstat(path.join(credentialParent, 'new-directory'))
					).rejects.toMatchObject({ code: 'ENOENT' });
				}
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
