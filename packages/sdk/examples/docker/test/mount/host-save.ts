import {
	link,
	readFile,
	rename,
	truncate,
	unlink,
	writeFile
} from 'node:fs/promises';

const input = await readFile('src/input', 'utf8');

await writeFile('src/save', 'from sandbox');
await rename('src/save', 'src/input');
await writeFile('src/next-save', 'next');

const outcomes: Record<string, string> = {};

const operations = {
	gitConfig: () => rename('src/next-save', 'admin/config'),
	absentHooks: () => rename('src/next-save', 'src/hooks'),
	settingsTarget: () => rename('src/next-save', 'src/editor-settings'),
	protectedFile: () => rename('src/next-save', 'config/.pi/config'),
	protectedAlias: () => rename('src/next-save', 'src/alias'),
	unlink: () => unlink('src/alias'),
	renameAlias: () => rename('src/next-save', 'src/second-name'),
	writeAlias: () => writeFile('src/second-name', 'edit'),
	truncateAlias: () => truncate('src/second-name', 0),
	link: () => link('src/input', 'src/new-link'),
	ancestor: () => rename('config', 'moved-config'),
	absent: () => writeFile('config/.pi/new-setting', 'new')
};

for (const [name, operation] of Object.entries(operations)) {
	try {
		await operation();
		outcomes[name] = 'allowed';
	} catch (error) {
		if (
			!(error instanceof Error) ||
			!('code' in error) ||
			typeof error.code !== 'string'
		) {
			throw error;
		}

		outcomes[name] = error.code;
	}
}

process.stdout.write(JSON.stringify({ input, outcomes }));
