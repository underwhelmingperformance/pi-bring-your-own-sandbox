import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
	SandboxOperation,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';
import {
	HOST_CONFIGURATION_PROTECTION,
	UnsupportedSandboxPolicyError
} from 'pi-bring-your-own-sandbox/api';

import type { DockerClient } from './contracts.js';

export function mount(fields: readonly string[]): string {
	return fields.map((field) => `"${field.replaceAll('"', '""')}"`).join(',');
}

async function entry(filename: string) {
	try {
		return await lstat(filename, { bigint: true });
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}

		throw error;
	}
}

const runGit = promisify(execFile);

const guardPaths = HOST_CONFIGURATION_PROTECTION.map((resource) =>
	resource.kind === 'git-metadata' ? '.git' : resource.path
);

async function hostGit(root: string): Promise<string | undefined> {
	const directories = (process.env['PATH'] ?? '').split(path.delimiter);

	for (const directory of directories) {
		if (!path.isAbsolute(directory)) {
			continue;
		}

		try {
			const executable = await realpath(path.join(directory, 'git'));
			const relative = path.relative(root, executable);

			if (!relative.startsWith('../')) {
				continue;
			}

			await access(executable, constants.X_OK);

			return executable;
		} catch (error) {
			if (!(
				error instanceof Error &&
				'code' in error &&
				['ENOENT', 'ENOTDIR', 'EACCES'].includes(String(error.code))
			)) {
				throw error;
			}
		}
	}

	return;
}

export class SharedCheckout {
	static async select(
		directory: string,
		client: DockerClient,
		context: SandboxOperationContext
	): Promise<SharedCheckout | string> {
		const uid = process.getuid?.();
		const gid = process.getgid?.();
		const root = await realpath(directory);
		const owner = await lstat(root);

		if (
			uid === undefined ||
			gid === undefined ||
			uid === 0 ||
			gid === 0 ||
			uid === 65_533 ||
			uid !== owner.uid ||
			!owner.isDirectory()
		) {
			return 'The checkout needs a non-root owner matching the Pi process.';
		}

		const checkout = new SharedCheckout(root, uid, gid, await hostGit(root));
		const guards = await checkout.#guards(context);

		if (typeof guards === 'string') {
			return guards;
		}

		const version = await client.command({
			args: ['version', '--format', '{{.Server.APIVersion}}'],
			context,
			operation: 'open',
			recovery: { kind: 'none' }
		});
		const api = /^(\d+)\.(\d+)$/u.exec(
			new TextDecoder().decode(version.stdout).trim()
		);

		if (
			!api ||
			version.status !== 0 ||
			(Number(api[1]) === 1 && Number(api[2]) < 45) ||
			Number(api[1]) < 1
		) {
			return 'Live editing requires volume subpaths (Docker API 1.45 or later).';
		}

		if (
			process.platform === 'darwin' &&
			/^\/private\/var\/folders\/[^/]+\/[^/]+\/T(?:\/|$)/u.test(root)
		) {
			const info = await client.command({
				args: ['info', '--format', '{{.OperatingSystem}}'],
				context,
				operation: 'open',
				recovery: { kind: 'none' }
			});

			if (new TextDecoder().decode(info.stdout).trim() === 'OrbStack') {
				return 'OrbStack can return truncated files after editor saves in the macOS per-user temporary directory.';
			}
		}

		return checkout;
	}

	private constructor(
		readonly root: string,
		readonly uid: number,
		readonly gid: number,
		private readonly gitExecutable: string | undefined
	) {}

	async #guards(context: SandboxOperationContext) {
		const paths = new Set(guardPaths);
		const git = await entry(path.join(this.root, '.git'));

		if (git && !git.isDirectory() && !git.isFile()) {
			return 'Git metadata uses a symbolic link or special file.';
		}

		if (git) {
			if (!this.gitExecutable) {
				return 'Docker needs a host Git installation outside the checkout to locate the Git metadata.';
			}

			try {
				const timeout = Math.max(1, Math.min(3000, context.remainingMs()));
				const { stdout } = await runGit(
					this.gitExecutable,
					[
						'-C',
						this.root,
						'rev-parse',
						'--path-format=absolute',
						'--git-dir',
						'--git-common-dir',
						'--git-path',
						'hooks'
					],
					{
						env: {
							PATH: path.dirname(this.gitExecutable),
							HOME: homedir(),
							GIT_OPTIONAL_LOCKS: '0',
							GIT_CEILING_DIRECTORIES: path.dirname(this.root)
						},
						signal: context.signal,
						timeout,
						maxBuffer: 32_768
					}
				);
				const resolved = stdout.trimEnd().split('\n');

				if (
					resolved.length !== 3 ||
					resolved.some((candidate) => !path.isAbsolute(candidate))
				) {
					return 'Docker could not identify the Git metadata for this checkout.';
				}

				for (const candidate of resolved) {
					const relative = path.relative(this.root, candidate);

					if (!relative) {
						return 'Git uses the checkout root as a protected resource.';
					}

					if (
						relative !== '..' &&
						!relative.startsWith('../') &&
						!relative.startsWith('.git/')
					) {
						paths.add(relative);
					}
				}
			} catch (error) {
				if (context.signal.aborted) {
					throw error;
				}

				return 'Docker could not identify the Git metadata for this checkout.';
			}
		}

		const guards = [];

		for (const name of paths) {
			const metadata = await entry(path.join(this.root, name));

			if (!metadata) {
				if (name === '.pi') {
					return 'The checkout has no .pi directory to mount read-only.';
				}

				continue;
			}

			if (
				(!metadata.isDirectory() && !metadata.isFile()) ||
				(name === '.pi' && !metadata.isDirectory())
			) {
				return 'A host configuration path is a symbolic link or special file.';
			}

			guards.push({
				name,
				identity: [String(metadata.dev), String(metadata.ino)]
			});
		}

		const settings = await entry(path.join(this.root, '.pi', 'settings.json'));
		const extensions = await entry(path.join(this.root, '.pi', 'extensions'));

		return (settings && (!settings.isFile() || settings.nlink !== 1n)) ||
			(extensions && !extensions.isDirectory())
			? 'Pi project extension registration uses a linked or nonstandard path.'
			: guards;
	}

	async mounts(
		volume: string,
		context: SandboxOperationContext,
		operation: SandboxOperation
	) {
		const guards = await this.#guards(context);

		if (typeof guards === 'string') {
			context.reportDiagnostic({
				level: 'warning',
				message: guards + ' Reopen the sandbox before editing.'
			});

			throw new UnsupportedSandboxPolicyError({
				operation,
				providerId: 'example.docker'
			});
		}

		return {
			key: JSON.stringify(guards),
			args: guards.flatMap(({ name }) => [
				'--mount',
				mount([
					'type=volume',
					`source=${volume}`,
					`target=/workspace/${name}`,
					`volume-subpath=${name}`,
					'readonly',
					'volume-nocopy'
				])
			])
		};
	}
}
