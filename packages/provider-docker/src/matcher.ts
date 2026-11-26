import { readFile } from 'node:fs/promises';
import { findPackageJSON } from 'node:module';
import path from 'node:path';

import { SandboxTransportError } from 'pi-bring-your-own-sandbox/provider';

export async function readDockerMatcher() {
	try {
		const manifest = findPackageJSON(
			'pi-byos-provider-docker',
			import.meta.url
		);

		if (manifest === undefined) {
			throw new Error('Cannot locate the Docker provider package.');
		}

		return await readFile(path.join(path.dirname(manifest), 'dist/re2js.mjs'));
	} catch (error) {
		throw new SandboxTransportError(
			{ operation: 'open', providerId: 'example.docker' },
			{
				cause: new Error(
					'The Docker matcher is unavailable. Run pnpm build in the provider checkout or install the packed provider.',
					{ cause: error }
				)
			}
		);
	}
}
