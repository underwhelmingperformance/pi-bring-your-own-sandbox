import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';
import { describe } from 'vitest';

import { dockerProvider } from '../src/provider.js';

import { DockerFixture } from './fixture.js';

describe.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')(
	'Docker reference provider (pnpm test:provider requires a local daemon and the pinned image)',
	() => {
		for (const [relationship, hostWorkspaceWrites] of [
			['shared', true],
			['shared', false],
			['copied', false]
		] as const) {
			defineSandboxProviderTests({
				workspaceVisibility: relationship,
				policyEffects: [
					'denied-network',
					...(relationship === 'copied'
						? (['late-special-file'] as const)
						: []),
					...(relationship === 'shared' && !hostWorkspaceWrites
						? (['read-only'] as const)
						: [])
				],
				verifyRecoveryAfterCancellation: true,
				verifyIndependentAllocations: true,
				verifyConcurrentCancellation: true,
				label: `Docker ${relationship} with host writes ${String(hostWorkspaceWrites)}`,
				provider: dockerProvider(),
				timeoutMs: 30_000,
				createFixture: async () => {
					const fixture = await DockerFixture.create();
					const contract = fixture.contract({
						hostWorkspaceWrites,
						hostUserData: 'denied',
						hostSystemFiles: 'denied',
						network: false
					});

					return {
						...contract,
						provider: dockerProvider(() => fixture.providerClient())
					};
				}
			});
		}

		const powerShellImage = process.env['BYOS_DOCKER_POWERSHELL_IMAGE'];

		if (powerShellImage === undefined) {
			return;
		}

		const provider = dockerProvider({ powerShellImage });
		const [profile] = provider.profiles.open;

		if (profile === undefined) {
			throw new Error('The Docker provider must declare an open profile.');
		}

		defineSandboxProviderTests({
			label: 'optional PowerShell image',
			provider,
			timeoutMs: 30_000,
			capabilities: {
				exitStatus: profile.exitStatus,
				terminationScope: profile.terminationScope,
				operations: ['exec'],
				processKinds: ['shell'],
				shells: ['powershell']
			},
			async createFixture() {
				const fixture = await DockerFixture.create();

				const base = fixture.contract({
					hostWorkspaceWrites: false,
					hostUserData: 'denied',
					hostSystemFiles: 'denied',
					network: false
				});

				return {
					...base,
					provider: dockerProvider({
						powerShellImage,
						createClient: () => fixture.providerClient()
					}),
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
