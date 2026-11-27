import { readFile as readSettingsFile } from 'node:fs/promises';

import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { ProcessRequest, SandboxBackend } from '../contracts.js';
import { InvalidSandboxConfigError } from '../errors.js';
import { registerUserShell } from '../user-shell.js';
import { isRecord } from '../validation.js';

import { FixtureConfig } from './config.js';
import type { FixtureCapabilities } from './profile-fixture.js';
import { fixtureProfile, fixtureProfiles } from './profile-fixture.js';

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

	const capabilities: FixtureCapabilities = {
		processKinds: ['argv', 'shell'],
		terminationScope: 'workload',
		exitStatus: 'guaranteed',
		operations: [],
		shells: ['sh']
	};

	const config = new FixtureConfig(async () => {
		const input: unknown = JSON.parse(
			await readSettingsFile(
				`${getAgentDir()}/user-shell-settings.json`,
				'utf8'
			)
		);

		return input;
	});

	config.activate(pi, {
		id: 'fixture',
		label: 'RPC fixture',
		profiles: fixtureProfiles(capabilities, {
			hostWorkspaceWrites: [true],
			hostUserData: ['denied'],
			hostSystemFiles: ['read-only'],
			network: [false]
		}),

		validateConfig(input: unknown) {
			if (
				!isRecord(input) ||
				typeof input['shouldWaitForReady'] !== 'boolean'
			) {
				throw new InvalidSandboxConfigError({ operation: 'configure' });
			}

			return { shouldWaitForReady: input['shouldWaitForReady'] };
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
					relationship: 'shared',
					defaultShell: 'sh'
				},
				profile: fixtureProfile(
					{
						hostWorkspaceWrites: true,
						hostUserData: 'denied',
						hostSystemFiles: 'read-only',
						network: false
					},
					capabilities
				),

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
