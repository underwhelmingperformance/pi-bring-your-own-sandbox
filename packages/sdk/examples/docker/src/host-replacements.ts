import { spawn } from 'node:child_process';
import { once } from 'node:events';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DockerConfig } from './contracts.js';

export async function connectHostReplacements(
	config: DockerConfig,
	container: string,
	workspace: string,
	staging: string
) {
	const host = spawn(
		'/usr/bin/sandbox-exec',
		[
			'-D',
			'WORKSPACE=' + workspace,
			'-D',
			'STAGING=' + staging,
			'-D',
			'PROTECTED=' + path.join(workspace, '.pi'),
			'-f',
			fileURLToPath(new URL('host-replace.sb', import.meta.url)),
			process.execPath,
			fileURLToPath(new URL('host-replace.ts', import.meta.url)),
			staging
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
