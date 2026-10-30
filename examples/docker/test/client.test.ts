import { spawn } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { NodeDockerClient } from '../src/client.js';
import type { DockerCommand } from '../src/contracts.js';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.useRealTimers();
});

function command(arguments_: readonly string[]): DockerCommand {
	return {
		args: arguments_,
		context: {
			operationId: 'fixture',
			signal: new AbortController().signal,
			deadline: Date.now() + 5000
		},
		operation: 'exec',
		recovery: { kind: 'none' }
	};
}

it('uses the fixed local daemon, preserves argv and excludes inherited Docker settings', async () => {
	vi.stubEnv('DOCKER_CONTEXT', 'unexpected-context');
	vi.stubEnv('BYOS_DOCKER_SENTINEL', 'synthetic-secret');
	const client = new NodeDockerClient(
		{ executable: process.execPath, socketPath: '/fixture/docker.sock' },
		(executable, arguments_, options) =>
			spawn(
				executable,
				[
					'-e',
					'process.stdout.write(JSON.stringify({args:process.argv.slice(1),context:process.env.DOCKER_CONTEXT,secret:process.env.BYOS_DOCKER_SENTINEL}));process.stderr.write("error");process.exitCode=7',
					'--',
					...arguments_
				],
				options
			)
	);
	const result = await client.command(
		command(['inspect', '$HOME', '; exit 99'])
	);
	const parsed: unknown = JSON.parse(new TextDecoder().decode(result.stdout));
	expect({
		status: result.status,
		stdout: parsed,
		stderr: new TextDecoder().decode(result.stderr)
	}).toStrictEqual({
		status: 7,
		stdout: {
			args: [
				'--host=unix:///fixture/docker.sock',
				'inspect',
				'$HOME',
				'; exit 99'
			]
		},
		stderr: 'error'
	});
});

it('streams attached bytes without retaining a second copy', async () => {
	const client = new NodeDockerClient(
		{ executable: process.execPath, socketPath: '/fixture/docker.sock' },
		(executable, arguments_, options) =>
			spawn(
				executable,
				[
					'-e',
					'process.stdout.write(Buffer.from([0,255,10]));process.stderr.write("error")',
					'--',
					...arguments_
				],
				options
			)
	);
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const result = await client.command({
		...command([]),
		onOutput(output) {
			(output.stream === 'stdout' ? stdout : stderr).push(
				new Uint8Array(output.data)
			);
		}
	});
	expect({
		result,
		stdout: new Uint8Array(Buffer.concat(stdout)),
		stderr: new TextDecoder().decode(Buffer.concat(stderr))
	}).toStrictEqual({
		result: { status: 0, stdout: new Uint8Array(), stderr: new Uint8Array() },
		stdout: new Uint8Array([0, 255, 10]),
		stderr: 'error'
	});
});

it('reports a lost CLI as a typed transport failure', async () => {
	const client = new NodeDockerClient({
		executable: '/byos-missing-docker',
		socketPath: '/fixture/docker.sock'
	});
	await expect(client.command(command([]))).rejects.toMatchObject({
		name: 'SandboxTransportError',
		completion: 'unknown'
	});
});

it('bounds a CLI that never completes without claiming target termination', async () => {
	const client = new NodeDockerClient(
		{ executable: process.execPath, socketPath: '/fixture/docker.sock' },
		(executable, arguments_, options) =>
			spawn(
				executable,
				['-e', 'setInterval(()=>{},1000)', '--', ...arguments_],
				options
			)
	);
	const request = command([]);
	await expect(
		client.command({
			...request,
			context: { ...request.context, deadline: Date.now() + 100 }
		})
	).rejects.toMatchObject({
		name: 'SandboxTransportError',
		completion: 'unknown'
	});
});

it.each(['deadline', 'output-limit'] as const)(
	'bounds %s failures when a subprocess inherits CLI pipes',
	async (mode) => {
		const directory = await mkdtemp(path.join(tmpdir(), 'byos-docker-pipes-'));
		const release = path.join(directory, 'release');
		const flood = path.join(directory, 'flood');
		const started = Promise.withResolvers<undefined>();
		const stopped = Promise.withResolvers<undefined>();
		const closed = Promise.withResolvers<undefined>();
		const failures: unknown[] = [];
		const grandchild = `const fs=require('node:fs'); process.stdout.write('ready'); setInterval(()=>{ if(fs.existsSync(${JSON.stringify(release)})) process.exit(0); if(fs.existsSync(${JSON.stringify(flood)})) process.stdout.write(Buffer.alloc(2*1024*1024)); },10);`;
		const wrapper = `require('node:child_process').spawn(process.execPath, ['-e',${JSON.stringify(grandchild)}], {stdio:'inherit'}); setInterval(()=>{},1000);`;
		vi.useFakeTimers();
		const client = new NodeDockerClient(
			{ executable: process.execPath, socketPath: '/fixture/docker.sock' },
			(executable, arguments_, options) => {
				const child = spawn(
					executable,
					['-e', wrapper, '--', ...arguments_],
					options
				);
				child.stdout.once('data', () => {
					started.resolve(undefined);
				});
				child.once('close', () => {
					closed.resolve(undefined);
				});
				const didSendSignal = child.kill.bind(child);
				child.kill = (signal) => {
					stopped.resolve(undefined);
					return didSendSignal(signal);
				};
				return child;
			},
			{
				kill(id: number, signal: NodeJS.Signals) {
					process.kill(id, signal);
					stopped.resolve(undefined);
				}
			}
		);
		const request = command([]);

		const running = (async () => {
			try {
				await client.command({
					...request,
					context: { ...request.context, deadline: Date.now() + 100 }
				});
			} catch (error) {
				failures.push(error);
			}
		})();
		try {
			await started.promise;
			if (mode === 'deadline') {
				await vi.advanceTimersByTimeAsync(100);
			} else {
				await writeFile(flood, 'flood');
			}
			await stopped.promise;
			await vi.advanceTimersByTimeAsync(0);
			expect(failures).toMatchObject([
				{ name: 'SandboxTransportError', completion: 'unknown' }
			]);
		} finally {
			vi.useRealTimers();
			await writeFile(release, 'release');
			await running;
			await closed.promise;
			await rm(directory, { recursive: true, force: true });
		}
	}
);

it('allows a short CLI command with a deadline beyond the Node timer range', async () => {
	const client = new NodeDockerClient(
		{ executable: process.execPath, socketPath: '/fixture/docker.sock' },
		(executable, arguments_, options) =>
			spawn(
				executable,
				[
					'-e',
					'setTimeout(()=>process.stdout.write("complete"),50)',
					'--',
					...arguments_
				],
				options
			)
	);
	const request = command([]);
	expect(
		await client.command({
			...request,
			context: { ...request.context, deadline: Date.now() + 3_000_000_000 }
		})
	).toStrictEqual({
		status: 0,
		stdout: new TextEncoder().encode('complete'),
		stderr: new Uint8Array()
	});
});
