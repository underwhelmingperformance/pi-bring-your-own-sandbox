import { readFileSync } from 'node:fs';

import { Type } from 'typebox';

import { computeProtocolBuild } from './compute-protocol-build.js';
import { checker, nonEmptyStringSchema } from './schemas.js';

const buildSchema = Type.Object({
	packageVersion: nonEmptyStringSchema,
	buildId: nonEmptyStringSchema
});
const isBuild = checker(buildSchema);
const cached: { value?: ReturnType<typeof computeProtocolBuild> } = {};

export function protocolBuild() {
	if (cached.value !== undefined) {
		return cached.value;
	}

	if (import.meta.filename.endsWith('.ts')) {
		cached.value = computeProtocolBuild();

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
