import { execFile } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { PROTOCOL_FEATURE_LEVEL, PROTOCOL_MAJOR } from './protocol-envelope.js';

const directory = new URL('fixtures/protocol-snapshots/', import.meta.url);
const execute = promisify(execFile);
const snapshotCommand = `
	import { protocolSchemas } from './dist/protocol-payloads.js';
	import { protocolSnapshot } from './dist/protocol-snapshot.js';

	const [major, level, schemaLevel] = process.argv.slice(1).map(Number);
	process.stdout.write(JSON.stringify(protocolSnapshot(major, level, protocolSchemas, schemaLevel)));
`;

async function builtSnapshot(
	level: number,
	schemaLevel = level
): Promise<unknown> {
	const { stdout } = await execute(
		process.execPath,
		[
			'--input-type=module',
			'--eval',
			snapshotCommand,
			String(PROTOCOL_MAJOR),
			String(level),
			String(schemaLevel)
		],
		{ cwd: new URL('../', import.meta.url), maxBuffer: 10 * 1024 * 1024 }
	);

	return JSON.parse(stdout) as unknown;
}

it('preserves every released schema at its feature level within the current major', async () => {
	const snapshots = await readdir(directory);
	const levels = Array.from(
		{ length: PROTOCOL_FEATURE_LEVEL + 1 },
		(_, level) => level
	);

	expect(
		snapshots.filter((name) => name.startsWith(`${String(PROTOCOL_MAJOR)}.`))
	).toStrictEqual(
		levels
			.map((level) => `${String(PROTOCOL_MAJOR)}.${String(level)}.json`)
			.toSorted((a, b) => Number(a > b) - Number(a < b))
	);

	for (const level of levels) {
		const name = `${String(PROTOCOL_MAJOR)}.${String(level)}.json`;
		const expected: unknown = JSON.parse(
			await readFile(new URL(name, directory), 'utf8')
		);
		const actual = await builtSnapshot(level);

		expect(actual, name).toStrictEqual(expected);
	}

	const annotated = await builtSnapshot(Number.MAX_SAFE_INTEGER);
	const current = await builtSnapshot(
		Number.MAX_SAFE_INTEGER,
		PROTOCOL_FEATURE_LEVEL
	);

	expect(annotated).toStrictEqual(current);
});
