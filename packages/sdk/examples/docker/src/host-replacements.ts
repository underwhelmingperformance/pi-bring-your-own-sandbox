import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { readFile, realpath } from 'node:fs/promises';

import type { DockerConfig } from './contracts.js';
import { hostPolicy } from './host-policy.js';

export async function connectHostReplacements(
	config: DockerConfig,
	container: string,
	workspacePath: string,
	stagingPath: string,
	additionalPaths: readonly string[] = []
) {
	const [runtime, workspace, staging] = await Promise.all([
		realpath(process.execPath),
		realpath(workspacePath),
		realpath(stagingPath)
	]);
	const script = await readFile(
		new URL('host-replace.ts', import.meta.url),
		'utf8'
	);
	const policy = await hostPolicy(workspace, staging, runtime, additionalPaths);
	const host = spawn(
		'/usr/bin/sandbox-exec',
		[
			...policy.args,
			runtime,
			'--input-type=module-typescript',
			'--eval',
			script,
			'--',
			staging,
			JSON.stringify(policy.protectedPaths)
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
