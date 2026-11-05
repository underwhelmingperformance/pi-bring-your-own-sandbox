import { execFile } from 'node:child_process';
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

const execute = promisify(execFile);
const loader =
	'const {createJiti}=await import("jiti");const run=await createJiti(import.meta.url).import(process.argv[1],{default:true});await run(process.argv[2]);';

it('demonstrates direct extension and MCP access outside the SDK boundary', async () => {
	const temporary = await mkdtemp(path.join(tmpdir(), 'byos-containment-'));
	const directory = await realpath(temporary);
	const marker = path.join(directory, 'host-marker');
	const probe = fileURLToPath(
		new URL('fixtures/containment-probe.ts', import.meta.url)
	);

	await writeFile(marker, 'host-marker');

	try {
		const modes =
			process.platform === 'darwin' ? ['host', 'seatbelt'] : ['host'];

		for (const mode of modes) {
			const arguments_ = ['--input-type=module', '-e', loader, probe, marker];
			const result =
				mode === 'host'
					? await execute(process.execPath, arguments_, { timeout: 20_000 })
					: await execute(
							'/usr/bin/sandbox-exec',
							[
								'-p',
								`(version 1)(allow default)(deny file-read* file-write* (literal ${JSON.stringify(marker)}))`,
								process.execPath,
								...arguments_
							],
							{ timeout: 20_000 }
						);
			const observed: unknown = JSON.parse(result.stdout);

			expect(observed).toStrictEqual({
				errors: [],
				results: [
					{
						isError: false,
						content: [
							{
								type: 'text',
								text: JSON.stringify({
									host: mode === 'host' ? 'host-marker' : 'denied',
									target: 'target-marker'
								})
							}
						]
					},
					{
						isError: false,
						content: [
							{ type: 'text', text: mode === 'host' ? 'host-marker' : 'denied' }
						]
					}
				]
			});
		}

		expect(await readFile(marker, 'utf8')).toBe('host-marker');
	} finally {
		await rm(directory, { recursive: true, force: true });
	}
}, 60_000);
