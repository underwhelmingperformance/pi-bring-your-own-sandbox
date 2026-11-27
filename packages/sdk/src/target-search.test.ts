import { execFile, spawnSync } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import {
	ripgrepParityCases,
	seedRipgrepParityCorpus
} from '../../../test-support/ripgrep-parity.js';

import type { FindRequest, GrepRequest } from './contracts.js';
import { GrepOutput } from './grep-output.js';
import { sandboxRipgrepArguments } from './ripgrep-arguments.js';
import { encodePosixArgv } from './shell-transport.js';
import {
	sandboxTargetTransferLimit,
	targetSearchHelper
} from './target-operations.js';

const execute = promisify(execFile);
const empty = { matches: [], truncated: false };
const isDarwin = process.platform === 'darwin';
const hasRipgrep =
	isDarwin && spawnSync('rg', ['--version'], { stdio: 'ignore' }).status === 0;

async function withWorkspace(
	exercise: (root: string) => Promise<void>
): Promise<void> {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-darwin-search-'));

	try {
		await exercise(await realpath(directory));
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}

async function search(
	helper: string,
	workspace: string,
	request: FindRequest | GrepRequest,
	operation: 'find' | 'grep' = 'grep'
): Promise<unknown> {
	const options = new URLSearchParams();

	for (const [key, value] of Object.entries(request)) {
		options.set(key, String(value));
	}

	try {
		const command = encodePosixArgv([
			process.execPath,
			'--input-type=module-typescript',
			'--eval',
			helper,
			'--',
			operation,
			options.toString(),
			String(sandboxTargetTransferLimit),
			workspace
		]);
		const { stdout } = await execute('/bin/sh', ['-c', command], {
			cwd: workspace
		});

		return JSON.parse(stdout) as unknown;
	} catch (error) {
		if (error instanceof Error && 'code' in error) {
			throw Object.assign(
				new Error(`Search helper exited with ${String(error.code)}.`),
				{
					code: error.code
				}
			);
		}

		throw error;
	}
}

it.skipIf(!hasRipgrep)(
	'matches the ripgrep traversal corpus with the opted-in Darwin reader',
	async () => {
		await withWorkspace(async (workspace) => {
			await execute('git', ['init', '-q'], { cwd: workspace });
			await seedRipgrepParityCorpus(workspace);

			const helper = await targetSearchHelper({
				sameConfinementAsCommands: true
			});

			for (const [root, glob] of ripgrepParityCases) {
				const request = {
					pattern: 'needle',
					path: root,
					...(glob !== undefined && { glob })
				};
				const basename = root === 'omitted.txt' ? root : '.';
				const directory = root === 'pruned' ? 'pruned' : '.';
				const arguments_ = sandboxRipgrepArguments(request, basename);
				const { stdout } = await execute('rg', arguments_, {
					cwd: path.join(workspace, directory),
					env: {
						PATH: process.env['PATH'],
						HOME: workspace,
						GIT_CONFIG_GLOBAL: '/dev/null'
					}
				});
				const output = new GrepOutput(0, 100, 'fixture.host');

				output.write(Buffer.from(stdout));
				expect(
					await search(helper, workspace, request),
					JSON.stringify({ root, glob })
				).toStrictEqual(output.finish());
			}
		});
	}
);

it.skipIf(process.platform === 'win32')(
	'applies portable find ignore files outside a Git checkout',
	async () => {
		await withWorkspace(async (workspace) => {
			await Promise.all([
				writeFile(path.join(workspace, '.gitignore'), 'git-ignored.txt\n'),
				writeFile(path.join(workspace, '.fdignore'), 'fd-ignored.txt\n'),
				writeFile(path.join(workspace, 'git-ignored.txt'), ''),
				writeFile(path.join(workspace, 'fd-ignored.txt'), ''),
				writeFile(path.join(workspace, 'visible.txt'), '')
			]);

			const helper = await targetSearchHelper({
				sameConfinementAsCommands: true
			});

			expect(
				await search(helper, workspace, { pattern: '*.txt' }, 'find')
			).toStrictEqual({
				paths: ['visible.txt'],
				truncated: false
			});
		});
	}
);

it('includes the bundled glob matcher licence in the target helper', async () => {
	expect(await targetSearchHelper()).toContain(
		'Copyright (c) 2017-present, Jon Schlinkert.'
	);
});

it('bounds incomplete grep records before a newline arrives', () => {
	const output = new GrepOutput(0, 100, 'fixture.search');
	const segment = new Uint8Array(524_288).fill(0x20);

	output.write(segment);
	output.write(segment);

	expect(() => {
		output.write(new Uint8Array([0x20]));
	}).toThrow(
		expect.objectContaining({
			name: 'SandboxOperationError',
			operation: 'grep',
			providerId: 'fixture.search'
		})
	);
});

it('reports the selected provider when a grep record is invalid', () => {
	const output = new GrepOutput(0, 100, 'fixture.search');

	expect(() => {
		output.write(Buffer.from('{}\n'));
	}).toThrow(
		expect.objectContaining({
			name: 'SandboxOperationError',
			operation: 'grep',
			providerId: 'fixture.search'
		})
	);
});

it('bounds retained grep text across individually valid records', () => {
	const output = new GrepOutput(0, 100, 'fixture.search');
	const filename = { text: 'fixture.txt' };
	const lines = { text: 'x'.repeat(524_288) + '\n' };

	output.write(
		Buffer.from(
			JSON.stringify({
				type: 'begin',
				data: { path: filename }
			}) + '\n'
		)
	);

	expect(() => {
		for (let line = 1; line <= 17; line++) {
			const event = {
				type: 'match',
				data: { path: filename, lines, line_number: line }
			};

			output.write(Buffer.from(JSON.stringify(event) + '\n'));
		}
	}).toThrow(
		expect.objectContaining({
			name: 'SandboxOperationError',
			operation: 'grep',
			providerId: 'fixture.search'
		})
	);
});

it.skipIf(!isDarwin)(
	'refuses Darwin search unless the provider opts in',
	async () => {
		await withWorkspace(async (workspace) => {
			await expect(
				search(await targetSearchHelper(), workspace, { pattern: 'needle' })
			).rejects.toMatchObject({
				code: 43
			});
		});
	}
);

it.skipIf(!isDarwin)(
	'opens neither a file nor Git metadata through a symlinked parent',
	async () => {
		await withWorkspace(async (workspace) => {
			const info = path.join(workspace, 'metadata');

			await mkdir(info);
			await mkdir(path.join(workspace, '.git'));
			await writeFile(path.join(info, 'exclude'), 'visible.txt\n');
			await writeFile(path.join(info, 'marker'), 'alias-only\n');
			await writeFile(path.join(workspace, 'visible.txt'), 'needle\n');
			await symlink(info, path.join(workspace, '.git', 'info'));

			const helper = await targetSearchHelper({
				sameConfinementAsCommands: true
			});

			expect({
				fromWorkspace: await search(helper, workspace, { pattern: 'needle' }),
				throughAlias: await search(helper, workspace, {
					path: '.git/info/marker',
					pattern: 'alias-only'
				})
			}).toStrictEqual({
				fromWorkspace: {
					matches: [
						{
							path: 'visible.txt',
							line: 1,
							text: 'needle',
							before: [],
							after: []
						}
					],
					truncated: false
				},
				throughAlias: empty
			});
		});
	}
);
