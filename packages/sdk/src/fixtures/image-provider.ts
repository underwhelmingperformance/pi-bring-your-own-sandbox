import type { SandboxProvider } from '../api.js';

import { fixtureProfile, fixtureProfiles } from './profile-fixture.js';

interface ImageConfig {
	readonly image: string;
}

export const imageProvider: SandboxProvider<ImageConfig> = {
	id: 'fixture.image',
	label: 'Image protocol fixture',
	profiles: fixtureProfiles(
		{
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: []
		},
		{
			hostWorkspaceWrites: [true],
			hostUserData: ['denied'],
			hostSystemFiles: ['read-only'],
			network: [false]
		}
	),

	validateConfig(input) {
		if (
			typeof input !== 'object' ||
			input === null ||
			!('image' in input) ||
			typeof input.image !== 'string'
		) {
			throw new TypeError('Set image to a string in the fixture settings.');
		}

		return { image: input.image };
	},
	open(request, context) {
		context.reportRecovery({ kind: 'none' });

		return Promise.resolve({
			id: request.configuration.image,
			workspace: {
				root: '/workspace',
				pathFlavor: 'posix',
				relationship: 'shared',
				description: 'In-memory protocol fixture; no image is started.'
			},
			profile: fixtureProfile(request.profile.policy, {
				processKinds: ['argv'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: []
			}),

			policyDescription: 'Protocol fixture only; no isolation.',
			recovery: { kind: 'none' },
			exec(_process, operation) {
				operation.onOutput({
					stream: 'stdout',
					data: new TextEncoder().encode('/workspace\n')
				});

				return Promise.resolve({
					kind: 'exited',
					exit: { kind: 'code', code: 0 }
				});
			},
			dispose: () => Promise.resolve()
		});
	}
};
