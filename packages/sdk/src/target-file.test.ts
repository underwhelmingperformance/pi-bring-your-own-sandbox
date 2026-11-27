import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { targetFileHelper } from './target-operations.js';

it('checks for an excess byte after the opened file grows', async () => {
	const directory = await mkdtemp(path.join(tmpdir(), 'byos-read-limit-'));
	const filename = path.join(directory, 'target');
	const content = 'first';

	try {
		await writeFile(filename, content);

		const helper = await targetFileHelper();
		const prelude = `
import { appendFileSync } from 'node:fs';
const writeChunk = process.stdout.write.bind(process.stdout);
let hasAppended = false;
process.stdout.write = (bytes, callback) => {
  if (!hasAppended) {
    hasAppended = true;
    appendFileSync(process.argv[2], 'extra');
  }
  return writeChunk(bytes, callback);
};
`;
		const result = spawnSync(
			process.execPath,
			[
				'--input-type=module-typescript',
				'--eval',
				prelude + helper,
				'--',
				'readFile',
				filename,
				'16777216',
				'0',
				String(content.length)
			],
			{ encoding: 'utf8' }
		);

		expect({
			status: result.status,
			stdout: result.stdout,
			stderr: result.stderr
		}).toStrictEqual({ status: 44, stdout: content, stderr: '' });
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
});
