import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { InvalidSandboxConfigError, registerSandboxProvider } from '../api.js';
import type {
	ProcessRequest,
	SandboxBackend,
	SandboxCapabilities
} from '../contracts.js';
import { registerUserShell } from '../user-shell.js';
import { isRecord } from '../validation.js';

export default function rpcFixture(pi: ExtensionAPI): void {
	const ready = Promise.withResolvers<'ready'>();
	const requests: ProcessRequest[] = [];

	pi.registerCommand('fixture-ready', {
		description: 'Finish fake startup',
		handler() {
			ready.resolve('ready');

			return Promise.resolve();
		}
	});

	const capabilities: SandboxCapabilities = {
		processKinds: ['argv', 'shell'],
		terminationScope: 'workload',
		exitStatus: 'guaranteed',
		operations: ['exec'],
		shells: ['sh']
	};

	registerSandboxProvider(pi, {
		id: 'fixture',
		label: 'RPC fixture',
		protocolVersion: 1,
		capabilities,
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		validateConfig(input: unknown) {
			if (!isRecord(input) || typeof input.shouldWaitForReady !== 'boolean') {
				throw new InvalidSandboxConfigError({ operation: 'configure' });
			}

			return { shouldWaitForReady: input.shouldWaitForReady };
		},
		async open(request) {
			pi.sendMessage({
				customType: 'fixture-opening',
				content: 'Opening the fake backend.',
				display: true
			});

			if (request.configuration.shouldWaitForReady) {
				await ready.promise;
			}

			const backend: SandboxBackend = {
				id: 'rpc-target',
				workspace: {
					root: '/rpc/target',
					pathFlavor: 'posix',
					relationship: 'remote',
					description: 'RPC test fixture; no OS isolation.',
					defaultShell: 'sh'
				},
				capabilities,
				policy: {
					workspaceAccess: 'read-write',
					filesystemScope: 'provider-default',
					networkAccess: 'provider-default'
				},
				policyDescription: 'RPC test fixture; no OS isolation.',
				recovery: { kind: 'none' },
				exec(command, context) {
					requests.push(command);
					context.onOutput({
						stream: 'stdout',
						data: new TextEncoder().encode(
							JSON.stringify({ requests, request: command })
						)
					});

					return Promise.resolve({
						kind: 'exited',
						exit: { kind: 'code', code: 3 }
					});
				},
				dispose() {
					return Promise.resolve();
				}
			};

			return backend;
		}
	});
	registerUserShell(pi);
}
