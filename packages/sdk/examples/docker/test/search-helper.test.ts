import { execFile } from 'node:child_process';
import {
	mkdir,
	mkdtemp,
	readFile,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

it('counts matching lines after glob and binary filtering and preserves adjacent context', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'docker-search-'));

	try {
		await mkdir(path.join(root, 'sub'));
		await mkdir(path.join(root, '.git'));
		await writeFile(
			path.join(root, 'sub', 'a.txt'),
			'before\r\nNeed.le\r\nafter\nneed.le\n'
		);
		await writeFile(path.join(root, 'binary.txt'), Buffer.from([0, 110]));
		await writeFile(path.join(root, '.git', 'data.txt'), 'need.le');
		await symlink('sub', path.join(root, 'alias'));

		const helper = await readFile(
			new URL('../src/search-helper.ts', import.meta.url),
			'utf8'
		);
		const { stdout } = await promisify(execFile)(process.execPath, [
			'--input-type=module-typescript',
			'--eval',
			helper,
			'--',
			'grep',
			new URLSearchParams({
				path: root,
				pattern: 'need.le',
				literal: 'true',
				ignoreCase: 'true',
				glob: '*.txt',
				context: '1',
				limit: '1'
			}).toString(),
			String(16 * 1024 * 1024)
		]);

		expect(JSON.parse(stdout)).toStrictEqual({
			matches: [
				{
					path: 'sub/a.txt',
					line: 2,
					text: 'Need.le',
					before: ['before'],
					after: ['after']
				}
			],
			truncated: true
		});
	} finally {
		await rm(root, { force: true, recursive: true });
	}
});
