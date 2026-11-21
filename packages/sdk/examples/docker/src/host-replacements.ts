import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { HOST_CONFIGURATION_PROTECTION } from 'pi-bring-your-own-sandbox/api';

import type { DockerConfig } from './contracts.js';

export async function connectHostReplacements(
	config: DockerConfig,
	container: string,
	workspace: string,
	staging: string,
	additionalPaths: readonly string[] = []
) {
	const runtime = await realpath(process.execPath);
	const script = await readFile(
		new URL('host-replace.ts', import.meta.url),
		'utf8'
	);
	const protectedPaths = [
		...new Set([
			...HOST_CONFIGURATION_PROTECTION.map((resource) =>
				resource.kind === 'path' ? resource.path : '.git'
			),
			...additionalPaths
		])
	];

	for (const relative of protectedPaths) {
		if (
			relative
				.split('/')
				.some(
					(part) =>
						!part || part === '.' || part === '..' || part.includes('\0')
				)
		) {
			throw new TypeError('Expected a relative protected workspace path.');
		}
	}

	const profile = await readFile(
		new URL('host-replace.sb', import.meta.url),
		'utf8'
	);
	const rules = protectedPaths.map((_, index) => {
		const parameter = '(param "RESOURCE_' + String(index) + '")';

		return (
			'(deny file-write* (subpath ' +
			parameter +
			'))\n' +
			'(deny file-write-unlink (path-ancestors ' +
			parameter +
			'))'
		);
	});
	const host = spawn(
		'/usr/bin/sandbox-exec',
		[
			'-D',
			'WORKSPACE=' + workspace,
			'-D',
			'RUNTIME=' + runtime,
			'-D',
			'STAGING=' + staging,
			...protectedPaths.flatMap((relative, index) => [
				'-D',
				'RESOURCE_' + String(index) + '=' + path.join(workspace, relative)
			]),
			'-p',
			[profile, ...rules].join('\n'),
			runtime,
			'--input-type=module-typescript',
			'--eval',
			script,
			'--',
			staging,
			JSON.stringify(protectedPaths)
		],
		{ cwd: workspace, stdio: ['pipe', 'pipe', 'inherit'], env: {} }
	);

	await once(host, 'spawn');

	const hostExit = once(host, 'exit');

	try {
		const channel = spawn(
			config.executable,
			[
				'--host',
				'unix://' + config.socketPath,
				'exec',
				'--interactive',
				container,
				'/mount-check',
				'host-channel'
			],
			{ stdio: [host.stdout, host.stdin, 'inherit'], env: {} }
		);

		await once(channel, 'spawn');

		const channelExit = once(channel, 'exit');

		host.stdin.destroy();
		host.stdout.destroy();

		return async () => {
			channel.kill();
			host.kill();
			await Promise.all([channelExit, hostExit]);
		};
	} catch (error) {
		host.kill();
		await hostExit;

		throw error;
	}
}
