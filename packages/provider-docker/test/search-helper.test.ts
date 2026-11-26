import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { targetSearchHelper } from 'pi-bring-your-own-sandbox/provider';
import { expect, it } from 'vitest';

it.skipIf(process.platform !== 'linux')(
	'counts matching lines after glob and binary filtering and preserves adjacent context',
	async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'docker-search-'));

		try {
			await mkdir(path.join(root, 'sub'));
			await mkdir(path.join(root, '.git'));
			await writeFile(
				path.join(root, 'sub', 'a.txt'),
				'before\r\nNeed.le\r\nafter\nneed.le\n'
			);
			await writeFile(path.join(root, 'binary.txt'), Buffer.from('need.le\0'));
			await writeFile(path.join(root, '.git', 'data.txt'), 'need.le');
			await writeFile(path.join(root, 'a.log'), 'need.le');
			await writeFile(
				Buffer.concat([Buffer.from(root + '/'), Buffer.from([255])]),
				'need.le'
			);
			await symlink('sub', path.join(root, 'alias'));

			const helper = await targetSearchHelper();
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
	}
);

it.skipIf(process.platform !== 'linux')(
	'reports truncation before building context for the omitted match',
	async () => {
		const root = await mkdtemp(path.join(tmpdir(), 'docker-search-'));

		try {
			await writeFile(path.join(root, 'a'), 'hit\n');
			await writeFile(path.join(root, 'b'), 'hit\n' + '\n'.repeat(65_537));

			const helper = await targetSearchHelper();
			const arguments_ = new URLSearchParams({
				path: root,
				pattern: 'hit',
				limit: '1',
				context: '65537'
			});
			const { stdout } = await promisify(execFile)(process.execPath, [
				'--input-type=module-typescript',
				'--eval',
				helper,
				'--',
				'grep',
				arguments_.toString(),
				String(16 * 1024 * 1024)
			]);

			expect(JSON.parse(stdout)).toStrictEqual({
				matches: [{ path: 'a', line: 1, text: 'hit', before: [], after: [] }],
				truncated: true
			});
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	}
);
