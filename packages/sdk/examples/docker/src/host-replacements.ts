import { execFile } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { promisify } from 'node:util';

import type { SandboxOpenContext } from 'pi-bring-your-own-sandbox/api';

import { attachHostChannel, hostRequests } from './host-channel.js';
import { isWorkspacePath, prepareHostPolicy } from './host-policy.js';

const run = promisify(execFile);

export async function connectHostReplacements(
	socketPath: string,
	apiVersion: string,
	container: string,
	workspacePath: string,
	stagingPath: string,
	additionalPaths: readonly string[],
	context: SandboxOpenContext
) {
	const [runtime, workspace, staging, script] = await Promise.all([
		realpath(process.execPath),
		realpath(workspacePath),
		realpath(stagingPath),
		readFile(new URL('host-replace.ts', import.meta.url), 'utf8')
	]);
	const prepare = await prepareHostPolicy(
		workspace,
		staging,
		runtime,
		additionalPaths
	);

	await prepare(undefined, context.signal);

	const controller = new AbortController();
	const remaining = Math.max(1, Math.ceil(context.remainingMs()));
	const opening = AbortSignal.any([
		context.signal,
		AbortSignal.timeout(remaining)
	]);
	const channel = await attachHostChannel(
		socketPath,
		container,
		apiVersion,
		opening
	);

	let channelFailure: Error | undefined;

	function disconnected(cause?: unknown) {
		if (controller.signal.aborted) {
			return;
		}

		channelFailure = new Error(
			'The Docker workspace connection closed. Reopen the workspace to resume editing.',
			{ cause }
		);
		controller.abort();
	}

	channel.once('error', disconnected);
	channel.once('end', disconnected);
	channel.once('close', disconnected);

	const serve = async (line: string) => {
		const request: unknown = JSON.parse(line);

		if (
			typeof request !== 'object' ||
			request === null ||
			!('op' in request) ||
			!('target' in request) ||
			!isWorkspacePath(request.target) ||
			((request.op === 'rename' || request.op === 'rename-file') &&
				(!('source' in request) || !isWorkspacePath(request.source)))
		) {
			return '{"status":"EINVAL"}\n';
		}

		const signal = AbortSignal.any([
			controller.signal,
			AbortSignal.timeout(4000)
		]);

		try {
			const policy = await prepare(
				request.op === 'rename-file' ? request.target : undefined,
				signal
			);

			signal.throwIfAborted();

			const result = await run(
				'/usr/bin/sandbox-exec',
				[
					...policy.args,
					runtime,
					'--input-type=module-typescript',
					'--eval',
					script,
					'--',
					staging,
					JSON.stringify(policy.protectedPaths),
					line
				],
				{
					cwd: workspace,
					env: {},
					signal,
					killSignal: 'SIGKILL',
					maxBuffer: 4096
				}
			);

			return result.stdout;
		} catch {
			return '{"status":"EIO"}\n';
		}
	};

	async function handleRequests() {
		try {
			for await (const line of hostRequests(channel)) {
				channel.write(await serve(line));
			}
		} catch (error) {
			disconnected(error);
		} finally {
			disconnected();
			channel.destroy();
		}
	}

	const serving = handleRequests();

	return {
		assertConnected() {
			if (channelFailure) {
				throw channelFailure;
			}
		},
		async close() {
			controller.abort();
			channel.destroy();
			await serving;
		}
	};
}
