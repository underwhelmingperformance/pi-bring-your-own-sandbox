import { readFile, rename, unlink, writeFile } from 'node:fs/promises';

const input = await readFile('src/input', 'utf8');

await writeFile('src/save', 'from sandbox');
await rename('src/save', 'src/input');
await writeFile('src/next-save', 'next');

const outcomes = [];

for (const operation of [
	() => rename('src/next-save', '.pi/config'),
	() => rename('src/next-save', 'src/alias'),
	() => unlink('src/alias'),
	() => rename('src/next-save', 'src/second-name'),
	() => writeFile('.pi/new-setting', 'new')
]) {
	try {
		await operation();
		outcomes.push('allowed');
	} catch (error) {
		if (!(error instanceof Error) || !('code' in error)) {
			throw error;
		}

		outcomes.push(error.code);
	}
}

process.stdout.write(JSON.stringify({ input, outcomes }));
