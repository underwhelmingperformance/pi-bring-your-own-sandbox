import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { Type } from 'typebox';

import { PROTOCOL_FEATURE_LEVEL, PROTOCOL_MAJOR } from './protocol-envelope.js';
import { protocolSchemas } from './protocol-payloads.js';
import { protocolSnapshot } from './protocol-snapshot.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

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

export function computeProtocolBuild() {
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
