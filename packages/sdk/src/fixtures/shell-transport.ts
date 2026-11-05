import assert from 'node:assert/strict';

import { Type } from 'typebox';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest
} from '../contracts.js';
import { hostError } from '../host-error.js';
import { PosixProcessRunner } from '../host-process.js';
import { checker } from '../schemas.js';

const replySchema = Type.Object({
	code: Type.Union([Type.Integer(), Type.Null()]),
	error: Type.Union([Type.String(), Type.Null()]),
	stdout: Type.String(),
	stderr: Type.String()
});
const isReply = checker(replySchema);

function quote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}

export class ShellTransportRunner {
	readonly #runner: PosixProcessRunner;
	readonly #workspace: string;
	readonly #environment: NodeJS.ProcessEnv;

	constructor(workspace: string, environment: NodeJS.ProcessEnv) {
		this.#workspace = workspace;
		this.#environment = environment;
		this.#runner = new PosixProcessRunner(
			workspace,
			{},
			new Map([['bash', '/bin/bash']])
		);
	}

	async run(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		assert.equal(request.kind, 'argv');

		const payload = JSON.stringify({
			request,
			workspace: this.#workspace,
			environment: this.#environment
		});
		const launcher = `
const { spawnSync } = require('node:child_process');
const path = require('node:path');
const { request, workspace, environment } = JSON.parse(process.argv[1]);
for (const [key, value] of Object.entries(request.env ?? {})) {
  if (value === null) { delete environment[key]; } else { environment[key] = value; }
}
const result = spawnSync(request.executable, request.args, {
  cwd: path.resolve(workspace, request.cwd ?? '.'), env: environment
});
process.stdout.write(JSON.stringify({
  code: result.status, error: result.error?.code ?? null,
  stdout: result.stdout?.toString('base64') ?? '',
  stderr: result.stderr?.toString('base64') ?? ''
}));
`;
		const command = ['exec', process.execPath, '-e', launcher, payload]
			.map((value) => quote(value))
			.join(' ');
		const chunks: Uint8Array[] = [];
		const outcome = await this.#runner.run(
			{ kind: 'shell', dialect: 'bash', command },
			{
				...context,
				onOutput(output) {
					assert.equal(output.stream, 'stdout');
					chunks.push(new Uint8Array(output.data));
				}
			}
		);

		assert.deepEqual(outcome, {
			kind: 'exited',
			exit: { kind: 'code', code: 0 }
		});

		const reply: unknown = JSON.parse(Buffer.concat(chunks).toString());

		assert.ok(isReply(reply));

		if (reply.error !== null) {
			throw hostError({ code: reply.error }, 'exec');
		}

		assert.ok(typeof reply.code === 'number');

		for (const stream of ['stdout', 'stderr'] as const) {
			context.onOutput({
				stream,
				data: new Uint8Array(Buffer.from(reply[stream], 'base64'))
			});
		}

		return { kind: 'exited', exit: { kind: 'code', code: reply.code } };
	}
}
