import { chmod, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

/**
Writes a fake Docker CLI named `docker` into `parent` and returns its path. It
answers only the current-context query, printing `BYOS_TEST_ENDPOINT` as the
endpoint, and fails when that variable is empty.
*/
export async function writeFakeDockerCli(parent: string): Promise<string> {
	const executable = path.join(parent, 'docker');

	await mkdir(parent, { recursive: true });
	await writeFile(
		executable,
		[
			'#!/bin/sh',
			`[ "$*" = 'context inspect --format {{json .Endpoints.docker.Host}}' ] || exit 64`,
			'[ -n "$BYOS_TEST_ENDPOINT" ] || exit 1',
			`printf '"%s"\\n' "$BYOS_TEST_ENDPOINT"`,
			''
		].join('\n')
	);
	await chmod(executable, 0o755);

	return executable;
}
