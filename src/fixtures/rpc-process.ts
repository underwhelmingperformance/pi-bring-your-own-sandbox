import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';

import type { RpcCommand } from '@earendil-works/pi-coding-agent';

import { isRecord } from '../validation.js';

export class RpcProcess {
	readonly #child;
	readonly #reader;
	readonly #exited = Promise.withResolvers<'exited'>();
	readonly #requests = new Map<string, PromiseWithResolvers<unknown>>();
	readonly #listeners = new Set<{
		readonly isMatch: (event: unknown) => boolean;
		readonly pending: PromiseWithResolvers<unknown>;
	}>();
	#nextId = 0;
	#failure: Error | undefined;
	#stderr = '';

	constructor(cliPath: string, directory: string, extension: string) {
		this.#child = spawn(
			process.execPath,
			[
				cliPath,
				'--mode',
				'rpc',
				'--offline',
				'--no-session',
				'--no-extensions',
				'--no-skills',
				'--no-prompt-templates',
				'--no-themes',
				'--extension',
				extension
			],
			{
				cwd: directory,
				env: { ...process.env, PI_CODING_AGENT_DIR: `${directory}/agent` },
				stdio: ['pipe', 'pipe', 'pipe']
			}
		);
		this.#child.stdin.on('error', (cause) => {
			this.#fail(new Error('The Pi RPC input stream failed.', { cause }));
		});
		this.#reader = createInterface({ input: this.#child.stdout });
		this.#reader.on('line', (line) => {
			this.#receive(line);
		});
		this.#child.stderr.on('data', (data: Buffer) => {
			this.#stderr = (this.#stderr + data.toString()).slice(-8192);
		});
		this.#child.once('error', (cause) => {
			this.#fail(new Error('The Pi RPC process failed.', { cause }));
		});
		this.#child.once('close', () => {
			this.#fail(new Error(`The Pi RPC process exited. ${this.#stderr}`));
			this.#exited.resolve('exited');
		});
	}

	#fail(error: Error): void {
		this.#failure ??= error;

		for (const request of this.#requests.values()) {
			request.reject(error);
		}

		this.#requests.clear();

		for (const listener of this.#listeners) {
			listener.pending.reject(error);
		}

		this.#listeners.clear();
	}

	#receive(line: string): void {
		let message: unknown;

		try {
			message = JSON.parse(line);
		} catch (error) {
			this.#fail(new Error('Pi emitted invalid RPC JSON.', { cause: error }));

			return;
		}

		if (
			!isRecord(message) ||
			message.type !== 'response' ||
			typeof message.id !== 'string'
		) {
			for (const listener of this.#listeners) {
				if (listener.isMatch(message)) {
					listener.pending.resolve(message);
				}
			}

			return;
		}

		this.#requests.get(message.id)?.resolve(message);
	}

	async waitForEvent(isMatch: (event: unknown) => boolean): Promise<unknown> {
		if (this.#failure !== undefined) {
			throw this.#failure;
		}

		const pending = Promise.withResolvers<unknown>();
		const listener = { isMatch, pending };

		this.#listeners.add(listener);

		const timer = setTimeout(() => {
			pending.reject(new Error('Pi did not emit the expected RPC event.'));
		}, 10_000);

		try {
			return await pending.promise;
		} finally {
			clearTimeout(timer);
			this.#listeners.delete(listener);
		}
	}

	async send(command: RpcCommand): Promise<unknown> {
		if (this.#failure !== undefined) {
			throw this.#failure;
		}

		const id = String(++this.#nextId);
		const pending = Promise.withResolvers<unknown>();

		this.#requests.set(id, pending);

		const timer = setTimeout(() => {
			pending.reject(
				new Error(`Pi RPC command ${command.type} timed out. ${this.#stderr}`)
			);
		}, 10_000);

		this.#child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);

		try {
			return await pending.promise;
		} finally {
			clearTimeout(timer);
			this.#requests.delete(id);
		}
	}

	async close(): Promise<void> {
		if (this.#child.exitCode !== null || this.#child.signalCode !== null) {
			this.#reader.close();

			return;
		}

		const timer = setTimeout(() => {
			this.#child.kill('SIGKILL');
		}, 2000);

		this.#child.kill('SIGTERM');

		try {
			await this.#exited.promise;
		} finally {
			clearTimeout(timer);
			this.#reader.close();
		}
	}
}
