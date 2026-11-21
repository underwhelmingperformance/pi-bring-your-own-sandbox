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
				workspaceVisibility: 'copied',
				policyEffects:
					workspaceAccess === 'read-only'
						? ['read-only', 'denied-network', 'late-special-file']
						: ['denied-network', 'late-special-file'],
				verifyRecoveryAfterCancellation: true,
				verifyIndependentAllocations: true,
				verifyConcurrentCancellation: true,
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

		const powerShellImage = process.env['BYOS_DOCKER_POWERSHELL_IMAGE'];

		if (powerShellImage === undefined) {
			return;
		}

		let prepared: DockerFixture | undefined;
		const provider = createDockerProvider({
			powerShellImage,
			createClient() {
				if (!prepared) {
					throw new Error('The PowerShell fixture has not been prepared.');
				}

				return prepared.providerClient();
			}
		});

		defineSandboxProviderTests({
			label: 'optional PowerShell image',
			provider,
			timeoutMs: 30_000,
			capabilities: {
				...provider.capabilities,
				operations: ['exec'],
				processKinds: ['shell'],
				shells: ['powershell']
			},
			async createFixture() {
				const fixture = await DockerFixture.create();

				prepared = fixture;

				const base = fixture.contract({
					workspaceAccess: 'read-only',
					filesystemScope: 'workspace-only',
					networkAccess: 'denied'
				});

				return {
					...base,
					shells: {
						powershell: {
							request: {
								kind: 'shell',
								dialect: 'powershell',
								command:
									'[Console]::Write((Get-Content -Raw source.txt)); exit 7'
							},
							exit: { kind: 'code', code: 7 },
							stdout: new TextEncoder().encode('original'),
							stderr: new Uint8Array()
						}
					}
				};
			}
		});
	}
);
