import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import { RpcProcess } from './fixtures/rpc-process.js';
import { observe } from './lifecycle.js';
import { isRecord } from './validation.js';

async function fixture(
	execute: (rpc: RpcProcess) => Promise<void>,
	shouldWaitForReady = false
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), 'pi-byos-user-rpc-'));

	try {
		await mkdir(path.join(directory, 'agent'));
		await writeFile(
			path.join(directory, 'agent', 'user-shell-settings.json'),
			JSON.stringify({
				provider: 'fixture',
				providerConfig: { shouldWaitForReady },
				policy: {
					workspaceAccess: 'read-write',
					filesystemScope: 'provider-default',
					networkAccess: 'provider-default'
				}
			})
		);

		const extension = fileURLToPath(
			new URL('fixtures/user-shell-rpc-extension.ts', import.meta.url)
		);
		const packageEntry = fileURLToPath(
			import.meta.resolve('@earendil-works/pi-coding-agent')
		);
		const cli = path.join(path.dirname(packageEntry), 'bundle', 'cli.js');
		const rpc = new RpcProcess(cli, directory, extension);

		try {
			await rpc.send({ type: 'get_state' });
			await execute(rpc);
		} finally {
			await rpc.close();
		}
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

it.each([false, true])(
	'routes RPC user shell with exclusion %s and records its transcript',
	async (excludeFromContext) => {
		await fixture(async (rpc) => {
			const response = await rpc.send({
				type: 'bash',
				command: 'user command',
				excludeFromContext
			});

			if (
				!isRecord(response) ||
				!isRecord(response.data) ||
				typeof response.data.output !== 'string'
			) {
				throw new Error('Pi returned an invalid RPC response.');
			}

			const output: unknown = JSON.parse(response.data.output);

			expect({
				...response,
				id: '<id>',
				data: { ...response.data, output }
			}).toStrictEqual({
				id: '<id>',
				type: 'response',
				command: 'bash',
				success: true,
				data: {
					output: {
						requests: [
							{
								kind: 'shell',
								dialect: 'sh',
								command: 'user command',
								cwd: '/rpc/target'
							}
						],
						request: {
							kind: 'shell',
							dialect: 'sh',
							command: 'user command',
							cwd: '/rpc/target'
						}
					},
					exitCode: 3,
					cancelled: false,
					truncated: false
				}
			});

			const messages = await rpc.send({ type: 'get_messages' });

			if (
				!isRecord(messages) ||
				!isRecord(messages.data) ||
				!Array.isArray(messages.data.messages)
			) {
				throw new Error('Pi returned an invalid message list.');
			}

			const records: unknown[] = messages.data.messages;
			const shellMessages = records
				.filter(
					(message) => isRecord(message) && message.role === 'bashExecution'
				)
				.map((message) => {
					if (!isRecord(message) || typeof message.output !== 'string') {
						throw new Error('A shell transcript record is invalid.');
					}

					const request: unknown = JSON.parse(message.output);

					return { ...message, timestamp: '<time>', output: request };
				});

			expect(shellMessages).toStrictEqual([
				{
					role: 'bashExecution',
					command: 'user command',
					output: {
						requests: [
							{
								kind: 'shell',
								dialect: 'sh',
								command: 'user command',
								cwd: '/rpc/target'
							}
						],
						request: {
							kind: 'shell',
							dialect: 'sh',
							command: 'user command',
							cwd: '/rpc/target'
						}
					},
					exitCode: 3,
					cancelled: false,
					truncated: false,
					timestamp: '<time>',
					excludeFromContext
				}
			]);
		});
	},
	20_000
);

it('aborts cold user-shell startup through RPC and runs only a later command', async () => {
	await fixture(async (rpc) => {
		const opening = observe(
			rpc.waitForEvent(
				(event) =>
					isRecord(event) &&
					event.type === 'message_end' &&
					isRecord(event.message) &&
					event.message.customType === 'fixture-opening'
			)
		);
		const running = observe(
			rpc.send({ type: 'bash', command: 'cancelled command' })
		);

		expect(await opening).toMatchObject({ kind: 'resolved' });

		const aborted = await rpc.send({ type: 'abort_bash' });

		if (!isRecord(aborted)) {
			throw new Error('Pi returned an invalid abort response.');
		}

		expect({ ...aborted, id: '<id>' }).toStrictEqual({
			id: '<id>',
			type: 'response',
			command: 'abort_bash',
			success: true
		});

		const cancelled = await running;

		if (cancelled.kind !== 'resolved' || !isRecord(cancelled.value)) {
			throw new Error('The cancelled RPC command did not complete.');
		}

		expect({ ...cancelled.value, id: '<id>' }).toStrictEqual({
			id: '<id>',
			type: 'response',
			command: 'bash',
			success: true,
			data: { output: '', cancelled: true, truncated: false }
		});
		await rpc.send({ type: 'prompt', message: '/fixture-ready' });

		const later = await rpc.send({ type: 'bash', command: 'later command' });

		if (
			!isRecord(later) ||
			!isRecord(later.data) ||
			typeof later.data.output !== 'string'
		) {
			throw new Error('Pi returned an invalid later command result.');
		}

		const output: unknown = JSON.parse(later.data.output);

		expect({
			...later,
			id: '<id>',
			data: { ...later.data, output }
		}).toStrictEqual({
			id: '<id>',
			type: 'response',
			command: 'bash',
			success: true,
			data: {
				output: {
					requests: [
						{
							kind: 'shell',
							dialect: 'sh',
							command: 'later command',
							cwd: '/rpc/target'
						}
					],
					request: {
						kind: 'shell',
						dialect: 'sh',
						command: 'later command',
						cwd: '/rpc/target'
					}
				},
				exitCode: 3,
				cancelled: false,
				truncated: false
			}
		});
	}, true);
}, 20_000);
