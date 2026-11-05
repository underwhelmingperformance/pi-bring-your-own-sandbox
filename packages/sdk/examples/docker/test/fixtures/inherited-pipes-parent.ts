import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

spawn(
	process.execPath,
	[
		fileURLToPath(new URL('inherited-pipes-child.ts', import.meta.url)),
		...process.argv.slice(2, 4)
	],
	{ stdio: 'inherit' }
);
