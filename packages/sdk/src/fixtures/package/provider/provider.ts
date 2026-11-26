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
	sample: string;
	opens: number;
	reviews: number;
	calls: ProcessRequest[];
	disposals: number;
	isRunning: boolean;
}

export const state: ProviderState = {
	sample: 'original',
	opens: 0,
	reviews: 0,
	calls: [],
	disposals: 0,
	isRunning: false
};

export const provider: SandboxProvider<undefined> = {
	id: 'packed.fixture',
	label: 'Packed provider fixture without OS isolation',
	profiles: {
		open: [true, false].map((hostWorkspaceWrites) => ({
			policy: {
				hostWorkspaceWrites,
				network: false,
				hostUserData: 'denied',
				hostSystemFiles: 'read-only'
			},
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			capabilities: ['exec'],
			shells: []
		})),
		copy: []
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
				relationship: 'shared',
				description: 'In-memory fixture without OS isolation.'
			},
			profile: request.profile,
			policyDescription: 'In-memory fixture without OS isolation.',
			recovery: { kind: 'none' },
			async exec(invocation, execution) {
				state.calls.push(invocation);

				if (
					invocation.kind === 'argv' &&
					invocation.executable === 'replace-sample'
				) {
					if (!request.profile.policy.hostWorkspaceWrites) {
						return { kind: 'exited', exit: { kind: 'code', code: 1 } };
					}

					state.sample = 'changed';

					return { kind: 'exited', exit: { kind: 'code', code: 0 } };
				}

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
			hostWorkspaceWrites: true,
			network: false,
			hostUserData: 'denied',
			hostSystemFiles: 'read-only'
		},
		open: (request, context) => provider.open(request, context)
	}
};

export default function register(pi: SandboxHost): void {
	sdk.registerSandboxProvider(pi, import.meta.filename, provider);
	sdk.configureExecutionApproval(pi, import.meta.filename, () => ({
		policy: 'packed.review'
	}));
	sdk.configureOutsideExecution(pi, import.meta.filename, () => ({
		destination: 'provider'
	}));
	sdk.registerApprovalPolicy(pi, import.meta.filename, {
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
