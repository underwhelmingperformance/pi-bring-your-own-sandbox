import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxTransportError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import type { HostProcessRunner } from './host-process.js';
import { PosixProcessRunner } from './host-process.js';
import { SandboxLaunchFrames } from './launch-frames.js';

/**
Encodes literal POSIX shell words. The caller selects the trusted command
and its argument boundaries. POSIX processes cannot receive NUL bytes.
*/
export function encodePosixArgv(argv: readonly string[]): string {
	return argv
		.map((value) => {
			if (value.includes('\0')) {
				throw new InvalidSandboxRequestError({
					operation: 'exec',
					detail: { kind: 'request', field: 'args' }
				});
			}

			return `'${value.replaceAll("'", "'\\''")}'`;
		})
		.join(' ');
}

const launcher = `
const { spawn } = require('node:child_process');
const { constants } = require('node:os');
const path = require('node:path');

const { request, workspace, environment } = JSON.parse(process.argv[1]);
const env = new Map(Object.entries(environment));
for (const [key, value] of Object.entries(request.env ?? {})) {
	if (value === null) {
		env.delete(key);
	} else {
		env.set(key, value);
	}
}

const child = spawn(request.executable, request.args, {
	cwd: path.resolve(workspace, request.cwd ?? '.'), env: Object.fromEntries(env),
	stdio: ['ignore', 'pipe', 'pipe']
});

function emit(frame) {
	if (!process.stdout.write(JSON.stringify(frame) + '\\n')) {
		child.stdout.pause();
		child.stderr.pause();
	}
}

process.stdout.on('drain', () => {
	child.stdout.resume();
	child.stderr.resume();
});
child.stdout.on('data', (data) => emit({ kind: 'stdout', data: data.toString('base64') }));
child.stderr.on('data', (data) => emit({ kind: 'stderr', data: data.toString('base64') }));
let failure;
child.on('error', ({ code }) => {
	failure = ['ENOENT', 'ENOTDIR'].includes(code)
		? 'not-found'
		: ['EACCES', 'EPERM', 'EROFS'].includes(code) ? 'permission-denied' : 'start-failed';
});
child.on('close', (code, signal) => {
	if (failure !== undefined) {
		emit({ kind: failure });
	} else if (signal !== null) {
		emit({ kind: 'exited', exit: { kind: 'signal', signal, signalNumber: constants.signals[signal] } });
	} else {
		emit({ kind: 'exited', exit: { kind: 'code', code } });
	}
});
`;

export interface ShellTransportOptions {
	readonly carrier?: HostProcessRunner;
	readonly dialect?: 'bash' | 'sh';
	readonly nodeExecutable?: string;
	readonly providerId?: string;
}

/**
Transports literal argv through a provider's POSIX shell runner. The carrier
must start a trusted Node launcher and stop its descendants on cancellation.
Request cwd and environment apply to the target program.
*/
export class ShellTransportRunner implements HostProcessRunner {
	readonly #carrier: HostProcessRunner;
	readonly #workspace: string;
	readonly #environment: NodeJS.ProcessEnv;
	readonly #options: ShellTransportOptions;

	constructor(
		workspace: string,
		environment: NodeJS.ProcessEnv,
		options: ShellTransportOptions = {}
	) {
		this.#workspace = workspace;
		this.#environment = { ...environment };
		this.#options = { ...options };
		this.#carrier =
			options.carrier ??
			new PosixProcessRunner(
				workspace,
				{},
				new Map([
					['bash', '/bin/bash'],
					['sh', '/bin/sh']
				])
			);
	}

	async run(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		const identity = {
			operation: 'exec' as const,
			...(this.#options.providerId !== undefined && {
				providerId: this.#options.providerId
			})
		};

		if (request.kind !== 'argv') {
			throw new UnsupportedSandboxCapabilityError(identity);
		}

		const payload = JSON.stringify({
			request,
			workspace: this.#workspace,
			environment: this.#environment
		});
		const argv = [
			this.#options.nodeExecutable ?? process.execPath,
			'-e',
			launcher,
			'--',
			payload
		];
		const frames = new SandboxLaunchFrames(context.onOutput, identity);
		const outcome = await this.#carrier.run(
			{
				kind: 'shell',
				dialect: this.#options.dialect ?? 'bash',
				command: 'exec ' + encodePosixArgv(argv)
			},
			{
				...context,
				onOutput: (output) => {
					frames.accept(output);
				}
			}
		);

		if (outcome.kind === 'cancelled') {
			return outcome;
		}

		if (outcome.exit.kind !== 'code' || outcome.exit.code !== 0) {
			throw new SandboxTransportError(identity);
		}

		return frames.finish();
	}
}
