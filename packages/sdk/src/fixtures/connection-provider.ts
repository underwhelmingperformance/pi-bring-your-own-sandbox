import { fixtureProfile, fixtureProfiles } from './profile-fixture.js';
import type { FixtureProvider } from './register-provider.js';

interface ConnectionConfig {
	readonly endpoint: URL;
}

export const connectionProvider: FixtureProvider<ConnectionConfig> = {
	id: 'fixture.connection',
	label: 'Connection protocol fixture',
	profiles: fixtureProfiles(
		{
			processKinds: ['argv', 'shell'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: ['sh']
		},
		{
			hostWorkspaceWrites: [false, true],
			hostUserData: ['denied'],
			hostSystemFiles: ['denied'],
			network: [false]
		}
	),

	validateConfig(input) {
		if (
			typeof input !== 'object' ||
			input === null ||
			!('endpoint' in input) ||
			typeof input.endpoint !== 'string'
		) {
			throw new TypeError('Set endpoint to a URL in the fixture settings.');
		}

		return { endpoint: new URL(input.endpoint) };
	},
	open(request, context) {
		context.reportRecovery({ kind: 'none' });

		return Promise.resolve({
			id: request.configuration.endpoint.host,
			workspace: {
				root: '/project',
				pathFlavor: 'posix',
				relationship: 'shared',
				description: 'In-memory protocol fixture; no connection is opened.',
				defaultShell: 'sh'
			},
			profile: fixtureProfile(request.profile.policy, {
				processKinds: ['argv', 'shell'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: ['sh']
			}),

			policyDescription: 'Protocol fixture only; no isolation.',
			recovery: { kind: 'none' },
			exec(_request, operation) {
				operation.onOutput({
					stream: 'stdout',
					data: new TextEncoder().encode('/project\n')
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
