import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import release from '../../../test-support/fixtures/byos-release-1.0.json' with { type: 'json' };

import { PROTOCOL_FEATURE_LEVEL, PROTOCOL_MAJOR } from './protocol-envelope.js';
import { isRecord } from './validation.js';

const directory = new URL('fixtures/protocol-snapshots/', import.meta.url);
const execute = promisify(execFile);
const snapshotCommand = `
	import { protocolSchemas } from './dist/protocol-payloads.js';
	import { protocolSnapshot } from './dist/protocol-snapshot.js';

	const [major, level, schemaLevel] = process.argv.slice(1).map(Number);
	process.stdout.write(JSON.stringify(protocolSnapshot(major, level, protocolSchemas, schemaLevel)));
`;

it('identifies the first release in both packages and the compiled SDK', async () => {
	const [sdk, docker, build] = await Promise.all(
		[
			'../package.json',
			'../../provider-docker/package.json',
			'../dist/protocol-build.json'
		].map(async (filename): Promise<unknown> => {
			return JSON.parse(
				await readFile(new URL(filename, import.meta.url), 'utf8')
			) as unknown;
		})
	);

	expect({
		sdk: isRecord(sdk) && sdk['version'],
		docker: isRecord(docker) && docker['version'],
		build: isRecord(build) && build['packageVersion']
	}).toStrictEqual({ sdk: '1.0.0', docker: '1.0.0', build: '1.0.0' });
});

it('retains the frozen protocol 1.0 snapshot', async () => {
	const original = await readFile(new URL('1.0.json', directory));
	const digest = createHash('sha256').update(original).digest('hex');

	expect({
		major: PROTOCOL_MAJOR,
		featureLevel: PROTOCOL_FEATURE_LEVEL,
		digest
	}).toStrictEqual({
		major: release.protocol.major,
		featureLevel: release.protocol.featureLevel,
		digest: release.protocol.snapshotSha256
	});
});

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
