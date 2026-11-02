import type { SandboxProvider } from '../api.js';

interface ImageConfig {
	readonly image: string;
}

export const imageProvider: SandboxProvider<ImageConfig> = {
	id: 'fixture.image',
	label: 'Image protocol fixture',
	protocolVersion: 1,
	capabilities: {
		processKinds: ['argv'],
		terminationScope: 'workload',
		exitStatus: 'guaranteed',
		operations: ['exec'],
		shells: []
	},
	policies: {
		workspaceAccess: ['read-write'],
		filesystemScope: ['provider-default'],
		networkAccess: ['provider-default']
	},
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
				relationship: 'copied',
				description: 'In-memory protocol fixture; no image is started.'
			},
			capabilities: {
				processKinds: ['argv'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: []
			},
			policy: request.policy,
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
