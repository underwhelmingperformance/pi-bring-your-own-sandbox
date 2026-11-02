import type { SandboxProvider } from '../api.js';

interface ConnectionConfig {
	readonly endpoint: URL;
}

export const connectionProvider: SandboxProvider<ConnectionConfig> = {
	id: 'fixture.connection',
	label: 'Connection protocol fixture',
	protocolVersion: 1,
	capabilities: {
		processKinds: ['argv', 'shell'],
		exitStatus: 'guaranteed',
		operations: ['exec'],
		shells: ['sh']
	},
	policies: {
		workspaceAccess: ['read-only', 'read-write'],
		filesystemScope: ['workspace-only'],
		networkAccess: ['denied']
	},
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
				relationship: 'remote',
				description: 'In-memory protocol fixture; no connection is opened.',
				defaultShell: 'sh'
			},
			capabilities: {
				processKinds: ['argv', 'shell'],
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: ['sh']
			},
			policy: request.policy,
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
