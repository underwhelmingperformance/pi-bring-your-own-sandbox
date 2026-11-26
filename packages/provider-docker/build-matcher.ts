import { copyFile, mkdir } from 'node:fs/promises';

const entry = new URL(import.meta.resolve('re2js'));
const output = new URL('dist/', import.meta.url);

await mkdir(output, { recursive: true });
await Promise.all([
	copyFile(entry, new URL('re2js.mjs', output)),
	copyFile(new URL('../LICENSE', entry), new URL('RE2JS-LICENSE', output))
]);
