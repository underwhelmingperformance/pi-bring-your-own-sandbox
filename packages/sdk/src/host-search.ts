import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import path from 'node:path';

import type {
	BackendSearch,
	FindRequest,
	FindResult,
	GrepRequest,
	GrepResult,
	ProcessRequest,
	SandboxOperationContext
} from './contracts.js';
import {
	SandboxCancelledError,
	SandboxOperationError,
	UnconfirmedSandboxTerminationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { GrepOutput } from './grep-output.js';
import type { HostOperations } from './host-operations.js';
import type { HostProcessRunner } from './host-process.js';
import type { SearchOutput } from './search-output.js';
import { FindOutput } from './search-output.js';
import { isRecord } from './validation.js';

export interface SearchTools {
	readonly find?: string;
	readonly grep?: string;
}

interface SearchCommand {
	readonly operation: 'find' | 'grep';
	readonly request: ProcessRequest;
}

interface SearchRoot {
	readonly directory: string;
	readonly target: string;
}

async function isInsideRepository(directory: string): Promise<boolean> {
	let current = directory;

	for (;;) {
		try {
			await access(path.join(current, '.git'));

			return true;
		} catch (error) {
			if (
				!isRecord(error) ||
				(error['code'] !== 'ENOENT' && error['code'] !== 'ENOTDIR')
			) {
				throw error;
			}
		}

		const parent = path.dirname(current);

		if (parent === current) {
			return false;
		}

		current = parent;
	}
}

export class HostSearch {
	readonly #workspace: string;
	readonly #tools: SearchTools;
	readonly #processes: HostProcessRunner;
	readonly #operations: HostOperations;

	constructor(
		workspace: string,
		tools: SearchTools,
		processes: HostProcessRunner,
		operations: HostOperations
	) {
		this.#workspace = workspace;
		this.#tools = { ...tools };
		this.#processes = processes;
		this.#operations = operations;
	}

	async #root(
		filename: string | undefined,
		operation: 'find' | 'grep'
	): Promise<SearchRoot> {
		const absolute = path.resolve(this.#workspace, filename ?? '.');
		const entry = await stat(absolute);

		if (
			(!entry.isDirectory() && !entry.isFile()) ||
			(operation === 'find' && !entry.isDirectory())
		) {
			throw new SandboxOperationError({ operation, providerId: 'passthrough' });
		}

		await access(
			absolute,
			entry.isDirectory() ? constants.R_OK | constants.X_OK : constants.R_OK
		);

		return {
			directory: entry.isDirectory() ? absolute : path.dirname(absolute),
			target: entry.isDirectory() ? '.' : path.basename(absolute)
		};
	}

	async #run<Result>(
		command: SearchCommand,
		context: SandboxOperationContext,
		output: SearchOutput<Result>
	): Promise<Result> {
		const { operation } = command;
		const stderr = new TextDecoder();
		let errorOutput = '';
		const outcome = await this.#processes.run(command.request, {
			...context,
			onOutput(chunk) {
				if (chunk.stream === 'stdout') {
					output.write(chunk.data);

					return;
				}

				if (errorOutput.length < 65_536) {
					errorOutput += stderr
						.decode(chunk.data, { stream: true })
						.slice(0, 65_536 - errorOutput.length);
				}
			}
		});

		if (outcome.kind === 'cancelled') {
			if (outcome.termination === 'unconfirmed') {
				throw new UnconfirmedSandboxTerminationError({
					operation,
					providerId: 'passthrough'
				});
			}

			throw new SandboxCancelledError({
				operation,
				providerId: 'passthrough',
				reason: 'caller',
				completion: 'confirmed'
			});
		}

		const successCodes = operation === 'grep' ? [0, 1] : [0];

		if (
			outcome.exit.kind !== 'code' ||
			!successCodes.includes(outcome.exit.code)
		) {
			throw new SandboxOperationError(
				{ operation, providerId: 'passthrough' },
				{ cause: new Error(errorOutput) }
			);
		}

		return output.finish();
	}

	find(
		request: FindRequest,
		context: SandboxOperationContext
	): Promise<FindResult> {
		return this.#operations.run('find', context, async (running) => {
			const executable = this.#tools.find;

			if (executable === undefined) {
				throw new UnsupportedSandboxCapabilityError({
					operation: 'find',
					providerId: 'passthrough'
				});
			}

			const root = await this.#root(request.path, 'find');
			const arguments_ = [
				'--glob',
				'--color=never',
				'--hidden',
				'--print0',
				'--exclude',
				'.git',
				'--exclude',
				'node_modules'
			];

			if (!(await isInsideRepository(root.directory))) {
				arguments_.push('--no-require-git');
			}

			let pattern = request.pattern;

			if (pattern.includes('/')) {
				arguments_.push('--full-path');

				if (!pattern.startsWith('/') && !pattern.startsWith('**/')) {
					pattern = `**/${pattern}`;
				}
			}

			arguments_.push('--', pattern, root.target);

			return this.#run(
				{
					operation: 'find',
					request: {
						kind: 'argv',
						executable,
						args: arguments_,
						cwd: root.directory
					}
				},
				running,
				new FindOutput(request.limit ?? 1000)
			);
		});
	}

	grep(
		request: GrepRequest,
		context: SandboxOperationContext
	): Promise<GrepResult> {
		return this.#operations.run('grep', context, async (running) => {
			const executable = this.#tools.grep;

			if (executable === undefined) {
				throw new UnsupportedSandboxCapabilityError({
					operation: 'grep',
					providerId: 'passthrough'
				});
			}

			const root = await this.#root(request.path, 'grep');
			const arguments_ = [
				'--no-config',
				'--json',
				'--line-number',
				'--color=never',
				'--hidden',
				'--no-mmap',
				'--no-follow',
				'--threads',
				'1',
				'--context',
				String(request.context ?? 0)
			];

			if (!(await isInsideRepository(root.directory))) {
				arguments_.push('--no-require-git');
			}

			if (request.ignoreCase === true) {
				arguments_.push('--ignore-case');
			}

			if (request.literal === true) {
				arguments_.push('--fixed-strings');
			}

			if (request.glob !== undefined) {
				arguments_.push(`--glob=${request.glob}`);
			}

			arguments_.push('--', request.pattern, root.target);

			return this.#run(
				{
					operation: 'grep',
					request: {
						kind: 'argv',
						executable,
						args: arguments_,
						cwd: root.directory
					}
				},
				running,
				new GrepOutput(request.context ?? 0, request.limit ?? 100)
			);
		});
	}

	methods(): BackendSearch | undefined {
		if (this.#tools.find === undefined && this.#tools.grep === undefined) {
			return undefined;
		}

		return {
			...(this.#tools.find !== undefined && { find: this.find.bind(this) }),
			...(this.#tools.grep !== undefined && { grep: this.grep.bind(this) })
		};
	}
}
