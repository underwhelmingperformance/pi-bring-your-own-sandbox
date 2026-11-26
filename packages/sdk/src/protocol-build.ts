import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';

import { PROTOCOL_FEATURE_LEVEL, PROTOCOL_MAJOR } from './protocol-envelope.js';
import { protocolSchemas } from './protocol-payloads.js';
import { protocolSnapshot } from './protocol-snapshot.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

const buildSchema = Type.Object({
	packageVersion: nonEmptyStringSchema,
	buildId: nonEmptyStringSchema
});
const isBuild = checker(buildSchema);
const isPackage = checker(Type.Object({ version: nonEmptyStringSchema }));
const directory = path.dirname(fileURLToPath(import.meta.url));
const extension = path.extname(import.meta.filename);

function files(root: string, suffix: string): readonly string[] {
	const sources: string[] = [];
	const entries = readdirSync(root, { withFileTypes: true });

	for (const entry of entries) {
		const file = path.join(root, entry.name);

		if (entry.isDirectory() && entry.name !== 'fixtures') {
			sources.push(...files(file, suffix));
		}

		if (
			entry.isFile() &&
			entry.name.endsWith(suffix) &&
			!entry.name.endsWith('.test.ts')
		) {
			sources.push(file);
		}
	}

	return sources;
}

function computeBuild() {
	const manifest: unknown = JSON.parse(
		readFileSync(new URL('../package.json', import.meta.url), 'utf8')
	);

	if (!isPackage(manifest)) {
		throw new Error('The SDK package does not identify its version.');
	}

	const snapshot = protocolSnapshot(
		PROTOCOL_MAJOR,
		PROTOCOL_FEATURE_LEVEL,
		protocolSchemas
	);
	const digest = createHash('sha256').update(JSON.stringify(snapshot));
	const sources = files(directory, extension).toSorted(
		(left, right) => Number(left > right) - Number(left < right)
	);

	for (const file of sources) {
		const source = readFileSync(file);
		const relative = path.relative(directory, file).split(path.sep).join('/');

		digest.update(JSON.stringify([relative, source.length]));
		digest.update(source);
	}

	return {
		packageVersion: manifest.version,
		buildId: `${manifest.version}+${digest.digest('hex')}`
	};
}

export function writeProtocolBuild(): void {
	writeFileSync(
		new URL('protocol-build.json', import.meta.url),
		JSON.stringify(computeBuild()) + '\n'
	);
}

const cached: { value?: ReturnType<typeof computeBuild> } = {};

export function protocolBuild() {
	if (cached.value !== undefined) {
		return cached.value;
	}

	if (extension === '.ts') {
		cached.value = computeBuild();

		return cached.value;
	}

	const build: unknown = JSON.parse(
		readFileSync(new URL('protocol-build.json', import.meta.url), 'utf8')
	);

	if (!isBuild(build)) {
		throw new Error('The built SDK does not contain a protocol identity.');
	}

	cached.value = build;

	return cached.value;
}
