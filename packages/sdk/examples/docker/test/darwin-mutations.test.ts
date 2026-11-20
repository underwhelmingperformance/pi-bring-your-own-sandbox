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
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const execute = promisify(execFile);
const profile = fileURLToPath(
	new URL('mount/darwin-mutations.sb', import.meta.url)
);

it.skipIf(process.platform !== 'darwin')(
	'authorises editor replacements on the macOS backing filesystem',
	async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'byos-darwin-'));
		const workspace = await realpath(directory);
		const file = (name: string) => path.join(workspace, name);
		const protectedDirectory = file('.pi');

		try {
			await mkdir(protectedDirectory);
			await mkdir(file('src'));
			await writeFile(file('src/input'), 'original');
			await writeFile(file('src/editor-save'), 'from editor');
			await rename(file('src/editor-save'), file('src/input'));
			await writeFile(file('.pi/config'), 'single');
			await writeFile(file('.pi/settings'), 'protected');
			await link(file('.pi/settings'), file('src/alias'));
			await writeFile(file('src/first-name'), 'shared inode');
			await link(file('src/first-name'), file('src/second-name'));

			const result = await execute(
				'/usr/bin/sandbox-exec',
				[
					'-D',
					'WORKSPACE=' + workspace,
					'-D',
					'PROTECTED=' + protectedDirectory,
					'-f',
					profile,
					process.execPath,
					fileURLToPath(new URL('mount/host-save.ts', import.meta.url))
				],
				{ cwd: workspace }
			);

			expect(JSON.parse(result.stdout)).toStrictEqual({
				input: 'from editor',
				outcomes: ['EPERM', 'EPERM', 'EPERM', 'EPERM', 'EPERM']
			});

			const entries = await readdir(protectedDirectory);
			const settings = await stat(file('.pi/settings'));
			const first = await stat(file('src/first-name'));
			const second = await stat(file('src/second-name'));

			expect({
				input: await readFile(file('src/input'), 'utf8'),
				entries: entries.toSorted((left, right) => left.localeCompare(right)),
				config: await readFile(file('.pi/config'), 'utf8'),
				settings: await readFile(file('.pi/settings'), 'utf8'),
				links: settings.nlink,
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
				ordinaryAlias: { sameInode: true, links: 2 },
				staged: 'next'
			});
		} finally {
			await rm(workspace, { recursive: true, force: true });
		}
	}
);
