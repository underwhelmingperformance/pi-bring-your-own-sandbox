import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import type { ProcessRequest } from './contracts.js';
import { isSandboxError, SandboxPathNotFoundError } from './errors.js';
import { ShellTransportRunner } from './fixtures/shell-transport.js';
import type { HostProcessRunner } from './host-process.js';
import { PosixProcessRunner } from './host-process.js';
import { snapshotProcessRequest } from './process-input.js';

const releases: (() => Promise<void>)[] = [];
const environment = {
	PATH: path.dirname(process.execPath),
	BYOS_DEFAULT: 'provider default',
	BYOS_REMOVE: 'present'
};
const probe = `
process.stdout.write(JSON.stringify({
  args: process.argv.slice(1), cwd: process.cwd(),
  default: process.env.BYOS_DEFAULT,
  removed: process.env.BYOS_REMOVE ?? 'absent',
  value: process.env.BYOS_VALUE ?? 'absent',
  bashEnv: process.env.BASH_ENV ?? 'absent',
  env: process.env.ENV ?? 'absent'
}));
process.stderr.write('target stderr');
process.exitCode = 7;
`;

async function execute(runner: HostProcessRunner, request: ProcessRequest) {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const outcome = await runner.run(request, {
		cleanup: { deadline: undefined },
		operationId: 'argv-conformance',
		signal: AbortSignal.timeout(5000),
		deadline: Date.now() + 5000,
		onOutput(output) {
			(output.stream === 'stdout' ? stdout : stderr).push(
				new Uint8Array(output.data)
			);
		}
	});

	return {
		outcome,
		stdout: Buffer.concat(stdout).toString(),
		stderr: Buffer.concat(stderr).toString()
	};
}

afterEach(async () => {
	for (const release of releases.splice(0)) {
		await release();
	}
});

describe.each(['direct', 'shell transport'] as const)(
	'%s argv conformance',
	(mode) => {
		async function fixture() {
			const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-argv-'));
			const directory = await realpath(temporary);

			releases.push(() => rm(directory, { recursive: true, force: true }));
			await mkdir(path.join(directory, 'cwd'));
			await mkdir(path.join(directory, 'bin'));

			const runner: HostProcessRunner =
				mode === 'direct'
					? new PosixProcessRunner(directory, environment, new Map())
					: new ShellTransportRunner(directory, environment);

			return { directory, runner };
		}

		it('preserves complete argument values and target environment semantics', async () => {
			const { directory, runner } = await fixture();
			const arguments_ = [
				'',
				' ',
				'a\tb',
				'"double" and \'single\'',
				'\\',
				'line\nend\n',
				'日本語 🐙',
				'$HOME',
				'$(printf expanded)',
				'`printf expanded`',
				'*?[abc]',
				'; exit 99',
				''
			];
			const removed: unknown = JSON.parse('null');
			const request = snapshotProcessRequest({
				kind: 'argv',
				executable: process.execPath,
				args: ['-e', probe, '--', ...arguments_],
				cwd: 'cwd',
				env: { BYOS_REMOVE: removed, BYOS_VALUE: 'literal $HOME\nvalue' }
			});
			const result = await execute(runner, request);

			expect(result).toStrictEqual({
				outcome: { kind: 'exited', exit: { kind: 'code', code: 7 } },
				stdout: JSON.stringify({
					args: arguments_,
					cwd: path.join(directory, 'cwd'),
					default: 'provider default',
					removed: 'absent',
					value: 'literal $HOME\nvalue',
					bashEnv: 'absent',
					env: 'absent'
				}),
				stderr: 'target stderr'
			});
		});

		it.each(['echo', 'cd', 'BYOS=value', '-literal', "sp ace'\nprogram"])(
			'resolves the literal executable %j through the target PATH',
			async (executable) => {
				const { directory, runner } = await fixture();

				await symlink(
					process.execPath,
					path.join(directory, 'bin', executable)
				);

				const result = await execute(runner, {
					kind: 'argv',
					executable,
					args: ['-e', 'process.stdout.write("target");process.exitCode=127'],
					cwd: 'cwd',
					env: { PATH: '../bin' }
				});

				expect(result).toStrictEqual({
					outcome: { kind: 'exited', exit: { kind: 'code', code: 127 } },
					stdout: 'target',
					stderr: ''
				});
			}
		);

		it('keeps shell startup overrides out of bootstrap execution', async () => {
			const { directory, runner } = await fixture();
			const startup = path.join(directory, 'startup');
			const marker = path.join(directory, 'marker');

			await writeFile(
				startup,
				`printf injected; printf injected > '${marker}'\n`
			);
			await writeFile(
				path.join(directory, 'bin', 'bash'),
				`#!/bin/sh\nprintf impostor\n`,
				{ mode: 0o755 }
			);

			const result = await execute(runner, {
				kind: 'argv',
				executable: process.execPath,
				args: ['-e', probe],
				env: {
					BASH_ENV: startup,
					ENV: startup,
					PATH: path.join(directory, 'bin'),
					SHELLOPTS: 'xtrace'
				}
			});

			expect(result).toStrictEqual({
				outcome: { kind: 'exited', exit: { kind: 'code', code: 7 } },
				stdout: JSON.stringify({
					args: [],
					cwd: directory,
					default: 'provider default',
					removed: 'present',
					value: 'absent',
					bashEnv: startup,
					env: startup
				}),
				stderr: 'target stderr'
			});
			await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' });
		});

		it('applies loader overrides to the target without loading them in the bootstrap', async () => {
			const { directory, runner } = await fixture();
			const preload = path.join(directory, 'preload.cjs');
			const marker = path.join(directory, 'loader-marker');

			await writeFile(
				preload,
				String.raw`require('node:fs').appendFileSync(${JSON.stringify(marker)}, 'loaded\n');`
			);

			const result = await execute(runner, {
				kind: 'argv',
				executable: process.execPath,
				args: ['-e', 'process.stdout.write("target")'],
				env: { NODE_OPTIONS: `--require=${preload}` }
			});

			expect({ result, marker: await readFile(marker, 'utf8') }).toStrictEqual({
				result: {
					outcome: { kind: 'exited', exit: { kind: 'code', code: 0 } },
					stdout: 'target',
					stderr: ''
				},
				marker: 'loaded\n'
			});
		});

		it.each(['executable', 'cwd'] as const)(
			'reports a missing %s as a typed start error',
			async (missing) => {
				const { runner } = await fixture();

				await expect(
					execute(runner, {
						kind: 'argv',
						executable:
							missing === 'executable'
								? 'byos-absent-program'
								: process.execPath,
						args: ['-e', 'process.exitCode=127'],
						...(missing === 'cwd' && { cwd: 'absent' })
					})
				).rejects.toSatisfy((error: unknown) =>
					isSandboxError(error, SandboxPathNotFoundError)
				);
			}
		);
	}
);
