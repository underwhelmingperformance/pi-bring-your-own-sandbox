import { copyFile, cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it } from 'vitest';

import { run, runIsolatedBuild } from '../../../test-support/packages.js';

it.skipIf(
	process.env['BYOS_PACKAGE_TESTS'] !== '1' || process.platform === 'win32'
)(
	'prepares the SDK with its declared tools outside the workspace',
	async () => {
		const directory = await mkdtemp(path.join(tmpdir(), 'byos-sdk-source-'));
		const source = path.join(directory, 'sdk');

		try {
			await mkdir(source);
			await Promise.all([
				cp('src', path.join(source, 'src'), { recursive: true }),
				copyFile('package.json', path.join(source, 'package.json')),
				copyFile(
					'tsconfig.build.json',
					path.join(source, 'tsconfig.build.json')
				)
			]);
			await runIsolatedBuild(source, path.join(directory, 'bin'), 'prepare');

			const result = await run(source, process.execPath, [
				'--input-type=module',
				'-e',
				"const sdk = await import('./dist/consumer.js'); process.stdout.write(typeof sdk.createSandboxClient);"
			]);

			expect(result.stdout).toBe('function');
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	120_000
);
