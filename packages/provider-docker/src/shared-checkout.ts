import { execFile } from 'node:child_process';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
	SandboxOperation,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/provider';
import { UnsupportedSandboxPolicyError } from 'pi-bring-your-own-sandbox/provider';
import {
	canonicalHostPath,
	cleanDisplayText,
	defaultProtectedWorkspacePaths,
	isProtectedWorkspacePath
} from 'pi-bring-your-own-sandbox/provider-kit';

import type { DockerClient } from './contracts.js';
import { findHostExecutable } from './host-executable.js';

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

const guardPaths = ['.git', ...defaultProtectedWorkspacePaths];

interface WorkspaceGuard {
	readonly name: string;
	readonly identity: readonly [string, string];
	readonly isProtected: boolean;
}

async function hasSpecialFiles(
	root: string,
	signal: AbortSignal
): Promise<boolean> {
	const directories = [root];

	while (directories.length > 0) {
		signal.throwIfAborted();

		const directory = directories.pop();

		if (directory === undefined) {
			break;
		}

		const entries = await readdir(directory, { withFileTypes: true });

		for (const entry of entries) {
			if (
				entry.isSocket() ||
				entry.isFIFO() ||
				entry.isCharacterDevice() ||
				entry.isBlockDevice()
			) {
				return true;
			}

			if (entry.isDirectory()) {
				directories.push(path.join(directory, entry.name));
			}
		}
	}

	return false;
}

async function hasProtectedAliases(
	root: string,
	signal: AbortSignal
): Promise<boolean> {
	const pending = [root];

	while (pending.length > 0) {
		signal.throwIfAborted();

		const filename = pending.pop();

		if (filename === undefined) {
			break;
		}

		const metadata = await entry(filename);

		if (metadata?.isDirectory()) {
			const children = await readdir(filename);

			for (const child of children) {
				pending.push(path.join(filename, child));
			}

			continue;
		}

		if (metadata?.isFile() !== true || metadata.nlink !== 1n) {
			return true;
		}
	}

	return false;
}

function gitIncludePaths(root: string, output: string): string[] {
	if (output === '') {
		return [];
	}

	const records = output.split('\0');

	if (records.pop() !== '' || records.length % 2 !== 0) {
		throw new Error('Git returned an invalid configuration listing.');
	}

	const includes: string[] = [];

	for (let index = 0; index < records.length; index += 2) {
		const origin = records[index];
		const record = records[index + 1];
		const separator = record?.indexOf('\n') ?? -1;

		if (origin === undefined || record === undefined || separator < 0) {
			throw new Error('Git returned an invalid include setting.');
		}

		const value = record.slice(separator + 1);

		if (path.isAbsolute(value)) {
			includes.push(value);

			continue;
		}

		if (value === '' || !origin.startsWith('file:')) {
			throw new Error('Git returned an include without a resolvable path.');
		}

		const directory = path.dirname(origin.slice(5));

		includes.push(path.resolve(root, directory, value));
	}

	return includes;
}

async function gitControlPaths(
	executable: string,
	root: string,
	context: SandboxOperationContext
): Promise<readonly string[]> {
	const configEnvironment = Object.fromEntries(
		Object.entries(process.env).filter(([key]) =>
			/^GIT_CONFIG_(?:GLOBAL|SYSTEM|NOSYSTEM|PARAMETERS|COUNT|(?:KEY|VALUE)_\d+)$/u.test(
				key
			)
		)
	);
	const options = () => ({
		env: {
			XDG_CONFIG_HOME: process.env['XDG_CONFIG_HOME'],
			...configEnvironment,
			PATH: path.dirname(executable),
			HOME: homedir(),
			GIT_OPTIONAL_LOCKS: '0',
			GIT_CEILING_DIRECTORIES: path.dirname(root)
		},
		signal: context.signal,
		timeout: Math.max(1, Math.min(3000, context.remainingMs())),
		maxBuffer: 32_768
	});
	const { stdout } = await runGit(
		executable,
		[
			'-C',
			root,
			'rev-parse',
			'--path-format=absolute',
			'--git-dir',
			'--git-common-dir',
			'--git-path',
			'hooks'
		],
		options()
	);
	const metadata = stdout.split('\n');

	if (
		metadata.pop() !== '' ||
		metadata.length !== 3 ||
		metadata.some((candidate) => !path.isAbsolute(candidate))
	) {
		throw new Error('Git returned an invalid metadata path.');
	}

	let includeOutput: string;

	try {
		({ stdout: includeOutput } = await runGit(
			executable,
			[
				'-C',
				root,
				'config',
				'--includes',
				'--null',
				'--path',
				'--show-origin',
				'--get-regexp',
				'^(include|includeif\\..*)\\.path$'
			],
			options()
		));
	} catch (error) {
		if (
			error instanceof Error &&
			'code' in error &&
			error.code === 1 &&
			'stdout' in error &&
			error.stdout === '' &&
			'stderr' in error &&
			error.stderr === ''
		) {
			return metadata;
		}

		throw error;
	}

	const includes = gitIncludePaths(root, includeOutput);

	const canonical = await Promise.all(
		includes.map((filename) => canonicalHostPath(filename))
	);

	return [...metadata, ...includes, ...canonical];
}

function hasVolumeSubpaths(version: string): boolean {
	const api = /^(\d+)\.(\d+)$/u.exec(version);

	if (!api) {
		return false;
	}

	const major = Number(api[1]);

	return major > 1 || (major === 1 && Number(api[2]) >= 45);
}

export class SharedCheckout {
	static async select(
		directory: string,
		client: DockerClient,
		context: SandboxOperationContext,
		canWrite: boolean
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

		if (await hasSpecialFiles(root, context.signal)) {
			return 'The live checkout contains a socket, FIFO or device file.';
		}

		const checkout = new SharedCheckout(
			root,
			uid,
			gid,
			await findHostExecutable('git', root)
		);
		const guards = await checkout.#guards(context, canWrite);

		if (typeof guards === 'string') {
			return guards;
		}

		checkout.#absent = guards.absent;

		const version = await client.command({
			args: [
				'version',
				'--format',
				'{{.Client.APIVersion}} {{.Server.APIVersion}}'
			],
			context,
			operation: 'open',
			recovery: { kind: 'none' }
		});
		const versions = new TextDecoder().decode(version.stdout).trim().split(' ');

		if (
			version.status !== 0 ||
			versions.length !== 2 ||
			versions.some((api) => !hasVolumeSubpaths(api))
		) {
			return 'Live editing requires volume subpaths in both the Docker CLI and daemon (API 1.45 or later).';
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

			const system = new TextDecoder().decode(info.stdout).trim();

			if (system === '<no value>' || info.status !== 0 || system.length === 0) {
				return 'Docker could not identify the filesystem service for this macOS temporary checkout.';
			}

			if (system === 'OrbStack') {
				return 'OrbStack can return truncated files after editor saves in the macOS per-user temporary directory.';
			}
		}

		return checkout;
	}

	#absent: readonly string[] = [];
	#created: string | undefined;

	private constructor(
		readonly root: string,
		readonly uid: number,
		readonly gid: number,
		private readonly gitExecutable: string | undefined
	) {}

	async #guards(context: SandboxOperationContext, canWrite: boolean) {
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
				const resolved = await gitControlPaths(
					this.gitExecutable,
					this.root,
					context
				);

				for (const candidate of resolved) {
					const relative = path.relative(this.root, candidate);

					if (!relative) {
						return 'Git uses the checkout root as a protected resource.';
					}

					if (
						relative !== '..' &&
						!relative.startsWith('../') &&
						!isProtectedWorkspacePath(relative, { paths: ['.git'] })
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

		const guards: WorkspaceGuard[] = [];
		const absent: string[] = [];

		for (const name of paths) {
			if (
				isProtectedWorkspacePath(name, {
					paths: guards.map((guard) => guard.name)
				})
			) {
				continue;
			}

			const metadata = await entry(path.join(this.root, name));

			if (!metadata) {
				if (name === '.pi') {
					return 'The checkout has no .pi directory to mount read-only.';
				}

				absent.push(name);

				continue;
			}

			if (
				(!metadata.isDirectory() && !metadata.isFile()) ||
				(name === '.pi' && !metadata.isDirectory())
			) {
				return 'A host configuration path is a symbolic link or special file.';
			}

			if (
				canWrite &&
				(await hasProtectedAliases(path.join(this.root, name), context.signal))
			) {
				return 'A protected checkout tree contains a file with an alias or an unsupported type.';
			}

			if (name.trim() !== name) {
				return 'The Docker CLI cannot mount this protected path with leading or trailing whitespace.';
			}

			guards.push({
				name,
				identity: [String(metadata.dev), String(metadata.ino)],
				isProtected: true
			});
		}

		const protectedPaths = guards.map(({ name }) => name);
		const pinned = new Set<string>();

		for (const name of protectedPaths) {
			for (
				let parent = path.dirname(name);
				parent !== '.';
				parent = path.dirname(parent)
			) {
				if (
					pinned.has(parent) ||
					isProtectedWorkspacePath(parent, { paths: protectedPaths })
				) {
					continue;
				}

				const metadata = await entry(path.join(this.root, parent));

				if (!metadata?.isDirectory() || parent.trim() !== parent) {
					return 'An ancestor of a protected path is missing, linked or cannot be mounted by Docker.';
				}

				pinned.add(parent);
				guards.push({
					name: parent,
					identity: [String(metadata.dev), String(metadata.ino)],
					isProtected: false
				});
			}
		}

		const settings = await entry(path.join(this.root, '.pi', 'settings.json'));
		const extensions = await entry(path.join(this.root, '.pi', 'extensions'));

		return (settings && (!settings.isFile() || settings.nlink !== 1n)) ||
			(extensions && !extensions.isDirectory())
			? 'Pi project extension registration uses a linked or nonstandard path.'
			: {
					absent,
					guards: guards.toSorted(
						(left, right) => left.name.length - right.name.length
					)
				};
	}

	async #findNewProtectedEntry(): Promise<string | undefined> {
		for (const name of this.#absent) {
			if (await entry(path.join(this.root, name))) {
				return name;
			}
		}

		return;
	}

	async checkForNewProtectedEntries(
		volume: string,
		context: SandboxOperationContext,
		operation: SandboxOperation
	): Promise<void> {
		const appeared =
			this.#created === undefined
				? await this.#findNewProtectedEntry()
				: undefined;

		if (appeared !== undefined && this.#created === undefined) {
			this.#created = appeared;

			const quoted = cleanDisplayText(JSON.stringify(appeared));

			context.reportWarning(
				`The protected path ${quoted} appeared after the Docker checkout opened. Remove the entry and reopen the sandbox.`
			);
		}

		if (this.#created !== undefined) {
			throw new UnsupportedSandboxPolicyError({
				operation,
				providerId: 'example.docker',
				backendId: volume,
				detail: {
					kind: 'request',
					field: 'protectedPath',
					value: this.#created
				}
			});
		}
	}

	async mounts(
		volume: string,
		context: SandboxOperationContext,
		operation: SandboxOperation,
		isWorkspaceReadOnly: boolean
	) {
		await this.checkForNewProtectedEntries(volume, context, operation);

		const selection = await this.#guards(context, !isWorkspaceReadOnly);

		if (typeof selection === 'string') {
			context.reportWarning(selection + ' Reopen the sandbox before editing.');

			throw new UnsupportedSandboxPolicyError({
				operation,
				providerId: 'example.docker'
			});
		}

		const { guards } = selection;

		return {
			key: JSON.stringify(guards),
			args: guards.flatMap(({ name, isProtected }) => [
				'--mount',
				mount([
					'type=volume',
					`source=${volume}`,
					`target=/workspace/${name}`,
					`volume-subpath=${name}`,
					...(isProtected || isWorkspaceReadOnly ? ['readonly'] : []),
					'volume-nocopy'
				])
			])
		};
	}
}
