import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { DockerConfig } from './contracts.js';

export async function connectHostReplacements(
	config: DockerConfig,
	container: string,
	workspace: string,
	staging: string
) {
	const runtime = await realpath(process.execPath);
	const script = await readFile(
		new URL('host-replace.ts', import.meta.url),
		'utf8'
	);
	const host = spawn(
		'/usr/bin/sandbox-exec',
		[
			'-D',
			'WORKSPACE=' + workspace,
			'-D',
			'RUNTIME=' + runtime,
			'-D',
			'STAGING=' + staging,
			'-D',
			'PROTECTED=' + path.join(workspace, '.pi'),
			'-f',
			fileURLToPath(new URL('host-replace.sb', import.meta.url)),
			runtime,
			'--input-type=module-typescript',
			'--eval',
			script,
			'--',
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
