import { randomUUID } from 'node:crypto';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import type {
	ProcessRequest,
	SandboxBackend,
	SandboxOperationContext,
	SandboxPolicy
} from 'pi-bring-your-own-sandbox/api';
import type { SandboxProviderTestFixture } from 'pi-bring-your-own-sandbox/testing';
import { expect } from 'vitest';

import { remainingBudget } from '../../../src/fixtures/remaining-budget.js';
import { NodeDockerClient } from '../src/client.js';
import type { DockerClient, DockerConfig } from '../src/contracts.js';
import { DOCKER_IMAGE } from '../src/image.js';
import { ALLOCATION_LABEL } from '../src/resources.js';

const NETWORK_PROBE = `
for (let attempt = 0; attempt < 10; attempt++) {
  try {
    const response = await fetch(process.argv[1], { signal: AbortSignal.timeout(100) });
    process.stdout.write(await response.text());
    process.exit(0);
  } catch {
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}
process.exitCode = 1;
`;

const encode = (text: string) => new TextEncoder().encode(text);

export function operationContext(): SandboxOperationContext {
	return {
		reportDiagnostic() {
			return;
		},
		cleanup: {
			deadline: undefined,
			remainingMs: (): undefined => {
				return;
			}
		},
		operationId: randomUUID(),
		signal: new AbortController().signal,
		deadline: Date.now() + 30_000,
		remainingMs: remainingBudget(30_000)
	};
}

export const cancellationRequest: ProcessRequest = {
	kind: 'argv',
	executable: '/usr/local/bin/node',
	args: [
		'-e',
		`
const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'process.stdout.write("ready"); setInterval(() => {}, 1000);'], {
  detached: true,
  stdio: ['ignore', 'inherit', 'inherit']
});
child.on('error', error => { throw error; });
child.on('exit', code => { process.exitCode = code ?? 1; });
`
	]
};

export class DockerFixture {
	static async create(workspace?: string): Promise<DockerFixture> {
		const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-docker-'));
		const directory = await realpath(temporary);
		const fixture = new DockerFixture(
			directory,
			workspace ?? path.join(directory, 'workspace')
		);

		try {
			await mkdir(fixture.workspace, { recursive: true });
			await mkdir(path.join(fixture.workspace, 'nested'));
			await writeFile(path.join(fixture.workspace, 'source.txt'), 'original');
			await writeFile(fixture.outside, 'host-only');
			await symlink(fixture.outside, path.join(fixture.workspace, 'escape'));

			return fixture;
		} catch (error) {
			await fixture.cleanup();

			throw error;
		}
	}

	readonly #directory: string;
	readonly #client: NodeDockerClient;
	readonly allocations = new Set<string>();
	readonly workspace: string;
	readonly outside: string;
	readonly server = `pi-byos-network-${randomUUID()}`;
	hasServer = false;
	readonly config: DockerConfig = {
		executable: process.env['BYOS_DOCKER_EXECUTABLE'] ?? '/usr/bin/docker',
		socketPath: process.env['BYOS_DOCKER_SOCKET'] ?? '/var/run/docker.sock'
	};

	private constructor(directory: string, workspace: string) {
		this.#directory = directory;
		this.workspace = workspace;
		this.outside = path.join(directory, 'outside');
		this.#client = new NodeDockerClient(this.config);
	}

	async #networkAddress(): Promise<string> {
		await this.docker([
			'create',
			'--name',
			this.server,
			'--pull=never',
			'--network=bridge',
			DOCKER_IMAGE,
			'/usr/local/bin/node',
			'-e',
			'require("node:http").createServer((_request, response) => response.end("controlled")).listen(8080, "0.0.0.0")'
		]);
		this.hasServer = true;
		await this.docker(['start', this.server]);

		const networks: unknown = JSON.parse(
			await this.docker([
				'inspect',
				'--format',
				'{{json .NetworkSettings.Networks}}',
				this.server
			])
		);

		if (
			typeof networks !== 'object' ||
			networks === null ||
			!('bridge' in networks) ||
			typeof networks.bridge !== 'object' ||
			networks.bridge === null ||
			!('IPAddress' in networks.bridge) ||
			typeof networks.bridge.IPAddress !== 'string'
		) {
			throw new TypeError(
				'Docker did not return a bridge address for the controlled server.'
			);
		}

		const address = networks.bridge.IPAddress;

		expect(address).toMatch(/^\d+\.\d+\.\d+\.\d+$/);

		const control = await this.docker([
			'run',
			'--rm',
			'--pull=never',
			'--network=bridge',
			DOCKER_IMAGE,
			'/usr/local/bin/node',
			'--input-type=module',
			'-e',
			NETWORK_PROBE,
			`http://${address}:8080/`
		]);

		expect(control).toBe('controlled');

		return address;
	}

	providerClient(): DockerClient {
		return {
			command: (command) => {
				if (command.recovery.kind === 'allocation') {
					this.allocations.add(command.recovery.id);
				}

				return this.#client.command(command);
			}
		};
	}

	async docker(arguments_: readonly string[]): Promise<string> {
		const result = await this.#client.command({
			args: arguments_,
			operation: 'exec',
			context: operationContext(),
			recovery: { kind: 'none' }
		});

		expect(
			result.status,
			`Docker ${arguments_[0] ?? 'command'} failed: ${new TextDecoder().decode(result.stderr)}`
		).toBe(0);

		return new TextDecoder().decode(result.stdout);
	}

	async noJobContainers(): Promise<void> {
		for (const allocation of this.allocations) {
			expect(
				await this.docker([
					'container',
					'ls',
					'--all',
					'--filter',
					`label=${ALLOCATION_LABEL}=${allocation}`,
					'--format',
					'{{.ID}}'
				])
			).toBe('');
		}
	}

	async verifyDisposed(): Promise<void> {
		await this.noJobContainers();

		for (const allocation of this.allocations) {
			expect(
				await this.docker([
					'volume',
					'ls',
					'--filter',
					`label=${ALLOCATION_LABEL}=${allocation}`,
					'--format',
					'{{.Name}}'
				])
			).toBe('');
		}
	}

	async policyChecks(
		backend: SandboxBackend,
		context: SandboxOperationContext
	): Promise<void> {
		const address = await this.#networkAddress();
		const result = await backend.exec(
			{
				kind: 'argv',
				executable: '/bin/sh',
				args: [
					'-c',
					'test ! -e "$1" && test ! -e /source && ! cat escape 2>/dev/null && ! /usr/local/bin/node --input-type=module -e "$3" "$2"',
					'fixture',
					this.outside,
					`http://${address}:8080/`,
					NETWORK_PROBE
				]
			},
			{
				...context,
				onOutput: () => {
					return;
				}
			}
		);

		expect(result).toStrictEqual({
			kind: 'exited',
			exit: { kind: 'code', code: 0 }
		});

		if (backend.policy.workspaceAccess === 'read-only') {
			const denied = await backend.exec(
				{
					kind: 'argv',
					executable: '/bin/sh',
					args: ['-c', 'printf changed > source.txt']
				},
				{
					...context,
					onOutput: () => {
						return;
					}
				}
			);
			const content = await this.docker([
				'run',
				'--rm',
				'--pull=never',
				'--network=none',
				'--read-only',
				'--mount',
				`type=volume,source=${backend.id},target=/workspace,readonly,volume-nocopy`,
				DOCKER_IMAGE,
				'/bin/cat',
				'/workspace/source.txt'
			]);

			expect({ denied, content }).toStrictEqual({
				denied: { kind: 'exited', exit: { kind: 'code', code: 2 } },
				content: 'original'
			});
		}

		expect(await readFile(this.outside, 'utf8')).toBe('host-only');
	}

	contract(policy: SandboxPolicy): SandboxProviderTestFixture {
		const cwd = '/workspace/nested';

		return {
			configuration: this.config,
			hostWorkspace: this.workspace,
			policy,
			processes: [
				{
					request: {
						kind: 'argv',
						executable: '/bin/sh',
						args: [
							'-c',
							'printf "%s\\n" "$1" "$2" "$PWD" "$BYOS_CONTRACT_VALUE"; printf error >&2; exit 7',
							'fixture',
							'$HOME',
							'; exit 99'
						],
						cwd: 'nested',
						env: { BYOS_CONTRACT_VALUE: 'target value' }
					},
					exit: { kind: 'code', code: 7 },
					stdout: encode(`$HOME\n; exit 99\n${cwd}\ntarget value\n`),
					stderr: encode('error')
				}
			],
			shells: {
				bash: {
					request: {
						kind: 'shell',
						dialect: 'bash',
						command: '[[ -n "$BASH_VERSION" ]] && printf bash'
					},
					exit: { kind: 'code', code: 0 },
					stdout: encode('bash'),
					stderr: new Uint8Array()
				},
				sh: {
					request: {
						kind: 'shell',
						dialect: 'sh',
						command: 'printf shell; printf error >&2; exit 7'
					},
					exit: { kind: 'code', code: 7 },
					stdout: encode('shell'),
					stderr: encode('error')
				}
			},
			cancellation: {
				request: cancellationRequest,
				ready: encode('ready'),
				verifyStopped: () => this.noJobContainers()
			},
			verifyPolicy: (backend, context) => this.policyChecks(backend, context),
			verifyDisposed: () => this.verifyDisposed(),
			cleanup: () => this.cleanup()
		};
	}

	async cleanup(): Promise<void> {
		try {
			if (this.hasServer) {
				await this.docker(['rm', '--force', this.server]);
			}

			for (const allocation of this.allocations) {
				const listed = await this.docker([
					'container',
					'ls',
					'--all',
					'--filter',
					`label=${ALLOCATION_LABEL}=${allocation}`,
					'--format',
					'{{.ID}}'
				]);
				const containers = listed.trim().split('\n').filter(Boolean);

				if (containers.length > 0) {
					await this.docker(['rm', '--force', ...containers]);
				}

				const listedVolumes = await this.docker([
					'volume',
					'ls',
					'--filter',
					`label=${ALLOCATION_LABEL}=${allocation}`,
					'--format',
					'{{.Name}}'
				]);
				const volumes = listedVolumes.trim();

				if (volumes !== '') {
					await this.docker(['volume', 'rm', allocation]);
				}
			}
		} finally {
			await rm(this.#directory, { recursive: true, force: true });
		}
	}
}
