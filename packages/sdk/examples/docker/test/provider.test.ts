import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';
import { describe } from 'vitest';

import { createDockerProvider } from '../src/provider.js';

import { DockerFixture } from './fixture.js';

describe.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')(
	'Docker reference provider (pnpm test:provider requires a local daemon and the pinned image)',
	() => {
		for (const workspaceAccess of ['read-write', 'read-only'] as const) {
			let fixture: DockerFixture | undefined;

			defineSandboxProviderTests({
				label: `Docker ${workspaceAccess}`,
				provider: createDockerProvider(() => {
					if (fixture === undefined) {
						throw new Error('The Docker fixture has not been prepared.');
					}

					return fixture.providerClient();
				}),
				timeoutMs: 30_000,
				createFixture: async () => {
					fixture = await DockerFixture.create();

					return fixture.contract({
						workspaceAccess,
						filesystemScope: 'workspace-only',
						networkAccess: 'denied'
					});
				}
			});
		}
	}
);
