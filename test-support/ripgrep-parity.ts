import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { GrepResult } from 'pi-bring-your-own-sandbox/provider';

const corpus = {
	'.gitignore': 'omitted.txt\npruned/\n',
	'.ignore': 'ignore-wins.txt\n',
	'.rgignore': '!ignore-wins.txt\nrg-omits.txt\n',
	'.git/info/exclude': 'git-excluded.txt\n',
	'.hidden.txt': 'needle\n',
	'.hidden.ts': 'needle\n',
	'nested/.hidden.ts': 'needle\n',
	'nested/visible.js': 'needle\n',
	'visible.ts': 'needle\n',
	'node_modules/pkg/index.txt': 'needle\n',
	'omitted.txt': 'needle\n',
	'pruned/deep.txt': 'needle\n',
	'git-excluded.txt': 'needle\n',
	'ignore-wins.txt': 'needle\n',
	'rg-omits.txt': 'needle\n',
	'unmatched.txt': 'different\n'
};

export const ripgrepParityCases = [
	['.', undefined],
	['.', 'omitted.txt'],
	['.', '*.ts'],
	['.', '**/*.{ts,js}'],
	['.', '[.v]*.ts'],
	['.', '!node_modules'],
	['omitted.txt', '*.md'],
	['pruned', undefined]
] as const;

export async function seedRipgrepParityCorpus(
	workspace: string
): Promise<void> {
	for (const [filename, content] of Object.entries(corpus)) {
		const target = path.join(workspace, filename);

		await mkdir(path.dirname(target), { recursive: true });
		await writeFile(target, content);
	}
}

export function ripgrepParityResult(output: string): GrepResult {
	const matches = output
		.split('\n')
		.filter(Boolean)
		.map((record) => {
			const match =
				/^(?<file>[^:]+):(?<line>[1-9]\d*):[1-9]\d*:(?<text>.*)$/u.exec(record);
			const file = match?.groups?.['file'];
			const line = match?.groups?.['line'];
			const text = match?.groups?.['text'];

			if (file === undefined || line === undefined || text === undefined) {
				throw new Error('Unexpected ripgrep output for the parity corpus.');
			}

			return {
				path: file.replace(/^\.\//u, ''),
				line: Number(line),
				text,
				before: [],
				after: []
			};
		});

	return {
		matches: matches.toSorted(
			(left, right) =>
				Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)) ||
				left.line - right.line
		),
		truncated: false
	};
}
