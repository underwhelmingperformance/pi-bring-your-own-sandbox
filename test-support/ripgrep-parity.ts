import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

const corpus = {
	'.gitignore': 'omitted.txt\npruned/\n',
	'.ignore': 'ignore-wins.txt\n',
	'.rgignore': '!ignore-wins.txt\nrg-omits.txt\n',
	'.git/info/exclude': 'git-excluded.txt\n',
	'.hidden.txt': 'needle\n',
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
