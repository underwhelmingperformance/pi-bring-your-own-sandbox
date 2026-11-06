import { constants } from 'node:fs';
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { constants as osConstants, tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import type { OperationCompletion, ProcessExit, Sandbox } from './contracts.js';
import { isSandboxError, SandboxCancelledError } from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { remainingBudget } from './fixtures/remaining-budget.js';
import { PosixProcessRunner } from './host-process.js';
import { openPassthrough } from './passthrough.js';
import { snapshotProcessRequest } from './process-input.js';

const releases: (() => Promise<void>)[] = [];

it.each([false, true])(
	'limits completion to the declared process group: cancellation %s',
	async (isCancelled) => {
		const { directory, sandbox, dispose } = await fixture();
		const controller = new AbortController();
		const childProgram = `
const fs = require('node:fs');
process.send('ready');
const timer = setInterval(() => {
  if (fs.existsSync('release')) {
    fs.writeFileSync('late', 'late effect');
    clearInterval(timer);
  }
}, 10);
`;
		const parentProgram = `
const child = require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(childProgram)}], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
child.on('message', () => {
  child.disconnect();
  ${isCancelled ? "child.on('exit', () => process.exit(0));" : 'child.unref();'}
  process.stdout.write('ready');
  ${isCancelled ? 'setInterval(() => {}, 1000);' : ''}
});
`;

		releases.push(async () => {
			await writeFile(path.join(directory, 'release'), 'go');
			await vi.waitFor(() => readFile(path.join(directory, 'late'), 'utf8'));
		});

		let outcome:
			| ProcessExit
			| {
					readonly name: 'SandboxCancelledError';
					readonly completion: OperationCompletion;
			  };

		try {
			const result = await sandbox.exec(
				{
					kind: 'argv',
					executable: process.execPath,
					args: ['-e', parentProgram]
				},
				{
					signal: controller.signal,
					onOutput() {
						if (isCancelled) {
							controller.abort();
						}
					}
				}
			);

			outcome = result.exit;
		} catch (error) {
			if (!isSandboxError(error, SandboxCancelledError)) {
				throw error;
			}

			outcome = { name: error.name, completion: error.completion };
		}

		await dispose();

		const marker = path.join(directory, 'late');
		let before: string;

		try {
			before = await readFile(marker, 'utf8');
		} catch (error) {
			expect(error).toMatchObject({ code: 'ENOENT' });
			before = 'absent';
		}

		await writeFile(path.join(directory, 'release'), 'go');

		const after = await vi.waitFor(() => readFile(marker, 'utf8'));

		expect({ outcome, before, after }).toStrictEqual({
			outcome: isCancelled
				? { name: 'SandboxCancelledError', completion: 'confirmed' }
				: { kind: 'code', code: 0 },
			before: 'absent',
			after: 'late effect'
		});
	}
);

it('waits for process-group disappearance after a denied existence probe', async () => {
	const { directory } = await fixture();
	let probes = 0;
	const output: string[] = [];
	const runner = new PosixProcessRunner(directory, process.env, new Map(), {
		kill(id, signal) {
			if (signal === 0 && probes++ === 0) {
				throw Object.assign(
					new Error('The group cannot currently be signalled.'),
					{ code: 'EPERM' }
				);
			}

			process.kill(id, signal);
		}
	});
	const result = await runner.run(
		{
			kind: 'argv',
			executable: process.execPath,
			args: ['-e', 'process.stdout.write("finished")']
		},
		{
			reportDiagnostic() {
				return;
			},
			cleanup: {
				deadline: undefined,
				remainingMs: (): undefined => {
					return;
				}
			},
			operationId: 'exec',
			signal: new AbortController().signal,
			deadline: Date.now() + 5000,
			remainingMs: remainingBudget(5000),
			onOutput(chunk) {
				output.push(new TextDecoder().decode(chunk.data));
			}
		}
	);

	expect({ result, output }).toStrictEqual({
		result: { kind: 'exited', exit: { kind: 'code', code: 0 } },
		output: ['finished']
	});
});

afterEach(async () => {
	vi.unstubAllEnvs();

	for (const release of releases.splice(0).toReversed()) {
		await release();
	}
});

async function fixture(
	prepare?: (directory: string) => Promise<void>
): Promise<{
	directory: string;
	sandbox: Sandbox;
	dispose: () => Promise<void>;
}> {
	const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-host-'));
	const directory = await realpath(temporary);

	releases.push(() => rm(directory, { recursive: true, force: true }));
	await prepare?.(directory);

	const backend = await openPassthrough(directory, {
		reportDiagnostic() {
			return;
		},
		cleanup: {
			deadline: undefined,
			remainingMs: (): undefined => {
				return;
			}
		},
		operationId: 'open',
		signal: new AbortController().signal,
		deadline: Date.now() + 10_000,
		remainingMs: remainingBudget(10_000),
		confirmCleanup() {
			return;
		},
		reportRecovery(recovery) {
			expect(recovery).toStrictEqual({ kind: 'none' });
		}
	});
	const owner = new TestBackendOwner(backend);
	const dispose = () =>
		backend.dispose({
			reportDiagnostic() {
				return;
			},
			cleanup: {
				deadline: undefined,
				remainingMs: (): undefined => {
					return;
				}
			},
			operationId: 'dispose',
			signal: new AbortController().signal,
			deadline: Date.now() + 10_000,
			remainingMs: remainingBudget(10_000)
		});

	releases.push(dispose);

	return { directory, sandbox: createSandbox(owner), dispose };
}

it('shares host files, preserves byte ownership and follows filesystem links', async () => {
	const { directory, sandbox } = await fixture();

	await sandbox.files.mkdir('nested');
	await sandbox.files.writeFile(
		'nested/file',
		new TextEncoder().encode('first\r\n')
	);
	await symlink('nested/file', path.join(directory, 'link'));
	await symlink('absent', path.join(directory, 'dangling'));

	const update = await sandbox.files.updateText(
		'link',
		(text) => `${text}second\n`
	);
	const entries = await sandbox.files.listDirectory('.');

	expect({
		workspace: sandbox.workspace,
		policy: sandbox.policy,
		update,
		content: await readFile(path.join(directory, 'nested/file'), 'utf8'),
		entries
	}).toStrictEqual({
		workspace: {
			root: directory,
			pathFlavor: 'posix',
			relationship: 'shared',
			home: process.env['HOME'],
			defaultShell: 'bash',
			description:
				'The host workspace is shared. No sandbox isolation is applied.'
		},
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		},
		update: { before: 'first\r\n', after: 'first\r\nsecond\n' },
		content: 'first\r\nsecond\n',
		entries: [
			{ name: 'dangling', kind: 'symlink' },
			{ name: 'link', kind: 'symlink' },
			{ name: 'nested', kind: 'directory' }
		]
	});
	await expect(sandbox.files.stat('dangling')).rejects.toMatchObject({
		name: 'SandboxPathNotFoundError'
	});

	const bytes = await sandbox.files.readFile('link');

	bytes.fill(0);
	expect(await sandbox.files.readFile('link')).toStrictEqual(
		new TextEncoder().encode('first\r\nsecond\n')
	);
});

it.each(['file', 'directory'] as const)(
	'resolves relative PATH entries from the workspace and requires an executable %s',
	async (entry) => {
		const { sandbox } = await fixture(async (directory) => {
			await mkdir(path.join(directory, 'bin'));

			const filename = path.join(directory, 'bin', 'bash');

			vi.stubEnv('PATH', './bin');

			if (entry === 'file') {
				await symlink('/bin/bash', filename);

				return;
			}

			await mkdir(filename);
		});

		expect(sandbox.capabilities.shells).toStrictEqual(
			entry === 'file' ? ['bash'] : []
		);
	}
);

it('executes argv without shell expansion and merges the inherited host environment', async () => {
	const { directory, sandbox } = await fixture();

	await mkdir(path.join(directory, 'cwd'));

	const removed: unknown = JSON.parse('null');
	const request = snapshotProcessRequest({
		kind: 'argv',
		executable: process.execPath,
		args: [
			'-e',
			'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),set:process.env.BYOS_TEST_VALUE,hasPath:typeof process.env.PATH,hasHome:typeof process.env.HOME}));process.stderr.write("error");process.exitCode=7',
			'$HOME',
			'; exit 99'
		],
		cwd: 'cwd',
		env: { BYOS_TEST_VALUE: 'value', HOME: removed }
	});
	const result = await sandbox.exec(request);
	const stdout: unknown = JSON.parse(new TextDecoder().decode(result.stdout));

	expect({
		exit: result.exit,
		stdout,
		stderr: new TextDecoder().decode(result.stderr),
		omittedBytes: result.omittedBytes
	}).toStrictEqual({
		exit: { kind: 'code', code: 7 },
		stdout: {
			args: ['$HOME', '; exit 99'],
			cwd: path.join(directory, 'cwd'),
			set: 'value',
			hasPath: 'string',
			hasHome: 'undefined'
		},
		stderr: 'error',
		omittedBytes: { stdout: 0, stderr: 0 }
	});
});

it.each(['bash', 'sh'] as const)(
	'executes an explicitly selected %s shell',
	async (dialect) => {
		const { sandbox } = await fixture();
		const result = await sandbox.exec({
			kind: 'shell',
			dialect,
			command: 'printf "%s" "$BYOS_TEST_VALUE"',
			env: { BYOS_TEST_VALUE: 'shell value' }
		});

		expect({
			exit: result.exit,
			stdout: new TextDecoder().decode(result.stdout)
		}).toStrictEqual({
			exit: { kind: 'code', code: 0 },
			stdout: 'shell value'
		});
	}
);

it.each(['file', 'executable', 'cwd'] as const)(
	'reports a missing %s without poisoning the host backend',
	async (missing) => {
		const { sandbox } = await fixture();
		const operation =
			missing === 'file'
				? sandbox.files.readFile('absent')
				: sandbox.exec({
						kind: 'argv',
						executable:
							missing === 'executable'
								? '/byos-nonexistent-program'
								: process.execPath,
						args: [],
						...(missing === 'cwd' && { cwd: 'absent' })
					});

		await expect(operation).rejects.toMatchObject({
			name: 'SandboxPathNotFoundError'
		});
		await sandbox.files.writeFile('after', new Uint8Array([1]));
		expect(await sandbox.files.readFile('after')).toStrictEqual(
			new Uint8Array([1])
		);
	}
);

it('rejects cancellation before invocation without host side effects', async () => {
	const { directory, sandbox } = await fixture();
	const controller = new AbortController();

	controller.abort();
	await expect(
		sandbox.exec(
			{
				kind: 'argv',
				executable: process.execPath,
				args: ['-e', 'require("node:fs").writeFileSync("unexpected","bad")']
			},
			{ signal: controller.signal }
		)
	).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'not-started'
	});
	await expect(
		access(path.join(directory, 'unexpected'), constants.F_OK)
	).rejects.toMatchObject({ code: 'ENOENT' });
});

it('confirms cancellation only after a real foreground descendant stops', async () => {
	const { sandbox } = await fixture();
	const controller = new AbortController();
	let childId = 0;
	const child =
		'process.stdout.write(String(process.pid)+"\\n");setInterval(()=>{},1000)';
	const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;

	await expect(
		sandbox.exec(
			{ kind: 'argv', executable: process.execPath, args: ['-e', script] },
			{
				signal: controller.signal,
				onOutput(output) {
					childId = Number(new TextDecoder().decode(output.data).trim());
					controller.abort();
				}
			}
		)
	).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'confirmed'
	});
	expect(childId).toBeGreaterThan(0);
	expect(() => process.kill(childId, 0)).toThrow(
		expect.objectContaining({ code: 'ESRCH' })
	);
});

it('does not acknowledge an exited parent while a foreground descendant is still active', async () => {
	const { directory, sandbox } = await fixture();
	const child = 'require("node:fs").writeFileSync("descendant","complete")';
	const script = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:'ignore'});process.exit(0)`;
	const result = await sandbox.exec({
		kind: 'argv',
		executable: process.execPath,
		args: ['-e', script]
	});

	expect({
		exit: result.exit,
		descendant: await readFile(path.join(directory, 'descendant'), 'utf8')
	}).toStrictEqual({ exit: { kind: 'code', code: 0 }, descendant: 'complete' });
});

it('aborts active host jobs during idempotent disposal and refuses later work', async () => {
	const { sandbox, dispose } = await fixture();
	const started = Promise.withResolvers<'started'>();
	const running = sandbox.exec(
		{
			kind: 'argv',
			executable: process.execPath,
			args: ['-e', 'process.stdout.write("ready");setInterval(()=>{},1000)']
		},
		{
			onOutput() {
				started.resolve('started');
			}
		}
	);
	const rejected = expect(running).rejects.toMatchObject({
		name: 'SandboxCancelledError',
		completion: 'confirmed'
	});

	await started.promise;
	await Promise.all([dispose(), dispose(), rejected]);
	await expect(
		sandbox.files.writeFile('after', new Uint8Array())
	).rejects.toMatchObject({ name: 'SandboxSessionClosingError' });
});

it.each(['deadline', 'output'] as const)(
	'confirms native process termination after %s cancellation',
	async (reason) => {
		const { sandbox } = await fixture();
		const request = {
			kind: 'argv',
			executable: process.execPath,
			args: [
				'-e',
				'process.on("SIGTERM",()=>{});process.stdout.write("ready");setInterval(()=>{},1000)'
			]
		} as const;
		const running = sandbox.exec(
			request,
			reason === 'deadline'
				? { timeoutMs: 200 }
				: {
						onOutput() {
							throw new Error('The consumer rejected output.');
						}
					}
		);

		await expect(running).rejects.toMatchObject({
			name:
				reason === 'deadline'
					? 'SandboxTimeoutError'
					: 'SandboxOutputCallbackError',
			completion: 'confirmed'
		});
		await sandbox.files.writeFile('after', new Uint8Array([1]));
		expect(await sandbox.files.readFile('after')).toStrictEqual(
			new Uint8Array([1])
		);
	}
);

it('reports the native signal number for a signal-terminated process', async () => {
	const { sandbox } = await fixture();
	const result = await sandbox.exec({
		kind: 'argv',
		executable: process.execPath,
		args: ['-e', 'process.kill(process.pid, "SIGTERM")']
	});

	expect({ ...result, durationMs: 0 }).toStrictEqual({
		exit: {
			kind: 'signal',
			signal: 'SIGTERM',
			signalNumber: osConstants.signals.SIGTERM
		},
		stdout: new Uint8Array(),
		stderr: new Uint8Array(),
		omittedBytes: { stdout: 0, stderr: 0 },
		durationMs: 0
	});
});
