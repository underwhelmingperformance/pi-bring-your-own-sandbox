import assert from 'node:assert/strict';

import type {
	ProcessRequest,
	SandboxHost,
	SandboxProvider
} from 'pi-bring-your-own-sandbox/api';
import * as sdk from 'pi-bring-your-own-sandbox/api';

export * as sdk from 'pi-bring-your-own-sandbox/api';

export const apiUrl = import.meta.resolve('pi-bring-your-own-sandbox/api');
interface ProviderState {
	opens: number;
	reviews: number;
	calls: ProcessRequest[];
	disposals: number;
	isRunning: boolean;
}

export const state: ProviderState = {
	opens: 0,
	reviews: 0,
	calls: [],
	disposals: 0,
	isRunning: false
};

export const provider: SandboxProvider<undefined> = {
	id: 'packed.fixture',
	label: 'Packed provider fixture without OS isolation',
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
		assert.deepEqual(input, {});
	},
	open(request, context) {
		state.opens++;
		context.reportRecovery({ kind: 'none' });

		let isDisposed = false;

		return Promise.resolve({
			id: 'packed-backend',
			workspace: {
				root: '/packed/project',
				pathFlavor: 'posix',
				relationship: 'remote',
				description: 'In-memory fixture without OS isolation.'
			},
			capabilities: {
				processKinds: ['argv'],
				terminationScope: 'workload',
				exitStatus: 'guaranteed',
				operations: ['exec'],
				shells: []
			},
			policy: request.policy,
			policyDescription: 'In-memory fixture without OS isolation.',
			recovery: { kind: 'none' },
			async exec(invocation, execution) {
				state.calls.push(invocation);

				if (invocation.kind === 'argv' && invocation.executable === 'wait') {
					state.isRunning = true;

					const stopped = Promise.withResolvers<undefined>();

					const stop = () => {
						state.isRunning = false;
						stopped.resolve(undefined);
					};

					execution.signal.addEventListener('abort', stop, { once: true });

					try {
						execution.onOutput({
							stream: 'stdout',
							data: new TextEncoder().encode('ready')
						});

						if (execution.signal.aborted) {
							stop();
						}

						await stopped.promise;

						return { kind: 'cancelled', termination: 'confirmed' };
					} finally {
						execution.signal.removeEventListener('abort', stop);
					}
				}

				assert.deepEqual(invocation, {
					kind: 'argv',
					executable: 'pwd',
					args: []
				});
				execution.onOutput({
					stream: 'stdout',
					data: new TextEncoder().encode('/packed/project\n')
				});

				return { kind: 'exited', exit: { kind: 'code', code: 0 } };
			},
			dispose() {
				if (!isDisposed) {
					isDisposed = true;
					state.disposals++;
				}

				return Promise.resolve();
			}
		});
	},
	outsideSandbox: {
		label: 'Packed outside destination',
		capabilities: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: []
		},
		policy: {
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		},
		open: (request, context) => provider.open(request, context)
	}
};

export default function register(pi: SandboxHost): void {
	sdk.registerSandboxProvider(pi, provider);
	sdk.registerApprovalPolicy(pi, {
		id: 'packed.review',
		label: 'Packed reviewer',
		protocolVersion: 1,
		validateConfig(input) {
			assert.deepEqual(input, {});
		},
		decide(request) {
			assert.equal(request.destination.kind, 'provider');
			assert.deepEqual(request.process, {
				kind: 'argv',
				executable: 'pwd',
				args: []
			});
			state.reviews++;

			return Promise.resolve({ kind: 'allow' });
		}
	});
}
