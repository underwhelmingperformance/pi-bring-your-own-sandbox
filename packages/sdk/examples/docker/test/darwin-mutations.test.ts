import { execFile } from 'node:child_process';
import {
	link,
	mkdir,
	mkdtemp,
	readdir,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { hostPolicy } from '../src/host-policy.js';

const execute = promisify(execFile);

it.skipIf(process.platform !== 'darwin')(
	'authorises editor replacements on the macOS backing filesystem',
	async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'byos-darwin-'));
		const workspace = await realpath(directory);
		const file = (name: string) => path.join(workspace, name);
		const runtime = await realpath(process.execPath);
		const protectedDirectory = file('config/.pi');

		try {
			await mkdir(protectedDirectory, { recursive: true });
			await mkdir(file('src'));
			await writeFile(file('src/input'), 'original');
			await writeFile(file('src/editor-save'), 'from editor');
			await rename(file('src/editor-save'), file('src/input'));
			await writeFile(file('config/.pi/config'), 'single');
			await writeFile(file('config/.pi/settings'), 'protected');
			await link(file('config/.pi/settings'), file('src/alias'));
			await writeFile(file('src/first-name'), 'shared inode');
			await link(file('src/first-name'), file('src/second-name'));

			const staging = file('staging');

			await mkdir(staging);

			const policy = await hostPolicy(workspace, staging, runtime, [
				'config/.pi'
			]);
			const workload = await readFile(
				new URL('mount/host-save.ts', import.meta.url),
				'utf8'
			);
			const result = await execute(
				'/usr/bin/sandbox-exec',
				[
					...policy.args,
					runtime,
					'--input-type=module-typescript',
					'--eval',
					workload
				],
				{ cwd: workspace, env: {} }
			);

			expect(JSON.parse(result.stdout)).toStrictEqual({
				input: 'from editor',
				outcomes: {
					protectedFile: 'EPERM',
					protectedAlias: 'EPERM',
					unlink: 'EPERM',
					renameAlias: 'EPERM',
					writeAlias: 'EPERM',
					truncateAlias: 'EPERM',
					link: 'EPERM',
					ancestor: 'EPERM',
					absent: 'EPERM'
				}
			});

			const entries = await readdir(protectedDirectory);
			const settings = await stat(file('config/.pi/settings'));
			const first = await stat(file('src/first-name'));
			const second = await stat(file('src/second-name'));

			expect({
				input: await readFile(file('src/input'), 'utf8'),
				entries: entries.toSorted((left, right) => left.localeCompare(right)),
				config: await readFile(file('config/.pi/config'), 'utf8'),
				settings: await readFile(file('config/.pi/settings'), 'utf8'),
				links: settings.nlink,
				bytes: await readFile(file('src/first-name'), 'utf8'),
				ordinaryAlias: {
					sameInode: first.ino === second.ino,
					links: first.nlink
				},
				staged: await readFile(file('src/next-save'), 'utf8')
			}).toStrictEqual({
				input: 'from sandbox',
				entries: ['config', 'settings'],
				config: 'single',
				settings: 'protected',
				links: 2,
				bytes: 'shared inode',
				ordinaryAlias: { sameInode: true, links: 2 },
				staged: 'next'
			});
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	}
);
