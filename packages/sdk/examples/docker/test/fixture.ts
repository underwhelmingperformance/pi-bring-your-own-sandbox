import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { connect, createServer, type Server } from 'node:net';
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

import { nodeVisibilityProbe } from '../../../src/fixtures/node-visibility-probe.js';
import { remainingBudget } from '../../../src/fixtures/remaining-budget.js';
import { NodeDockerClient } from '../src/client.js';
import { resolveDockerConfig } from '../src/config.js';
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
const sourceRead = {
	request: {
		kind: 'argv',
		executable: '/bin/cat',
		args: ['source.txt']
	},
	exit: { kind: 'code', code: 0 },
	stdout: encode('original'),
	stderr: new Uint8Array()
} as const;

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
		const executable = process.env['BYOS_DOCKER_EXECUTABLE'];
		const socketPath = process.env['BYOS_DOCKER_SOCKET'];
		const config = await resolveDockerConfig(
			{
				...(executable !== undefined && { executable }),
				...(socketPath !== undefined && { socketPath })
			},
			{
				workspace: process.cwd(),
				signal: AbortSignal.timeout(30_000),
				reportDiagnostic() {
					return;
				}
			}
		);
		const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-docker-'));
		const directory = await realpath(temporary);
		const fixture = new DockerFixture(
			directory,
			workspace ?? path.join(directory, 'workspace'),
			config
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
	#localListener: Server | undefined;
	#socketDirectory: string | undefined;
	readonly allocations = new Set<string>();
	readonly workspace: string;
	readonly outside: string;
	readonly server = `pi-byos-network-${randomUUID()}`;
	hasServer = false;
	readonly config: DockerConfig;

	private constructor(
		directory: string,
		workspace: string,
		config: DockerConfig
	) {
		this.#directory = directory;
		this.workspace = workspace;
		this.config = config;
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
			`let connections = 0;
const server = require('node:http').createServer((request, response) => {
	response.end(request.url === '/count' ? String(connections) : 'controlled');
});
server.on('connection', socket => {
	if (socket.remoteAddress !== '127.0.0.1') connections++;
});
server.listen(8080, '0.0.0.0');`
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

	async #waitingPeer(context = operationContext()) {
		const [allocation] = this.allocations;

		if (allocation === undefined) {
			throw new Error('The concurrent jobs have no Docker allocation.');
		}

		const running = await this.docker(
			[
				'ps',
				'--all',
				'--filter',
				`label=${ALLOCATION_LABEL}=${allocation}`,
				'--format',
				'{{.Names}}'
			],
			context
		);
		const candidates = running
			.trim()
			.split('\n')
			.filter(
				(item) => item.length > 0 && !item.startsWith(allocation + '-files-')
			);

		if (candidates.length === 0) {
			return;
		}

		const [peer] = candidates;

		if (!peer || candidates.length !== 1) {
			throw new Error('Unexpected Docker job after cancellation.');
		}

		await this.docker(
			['exec', peer, '/usr/bin/test', '-f', '/tmp/peer-ready'],
			context
		);

		return peer;
	}

	async socketEndpoint(): Promise<string> {
		this.#socketDirectory = await mkdtemp('/tmp/pi-byos-socket-');

		const workspace = path.join(this.#socketDirectory, 'w');

		await symlink(this.workspace, workspace);

		return path.join(workspace, 's');
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

	async docker(
		arguments_: readonly string[],
		context: SandboxOperationContext = operationContext()
	): Promise<string> {
		const result = await this.#client.command({
			args: arguments_,
			operation: 'exec',
			context,
			recovery: { kind: 'none' }
		});

		expect(
			result.status,
			`Docker ${arguments_[0] ?? 'command'} failed: ${new TextDecoder().decode(result.stderr)}`
		).toBe(0);

		return new TextDecoder().decode(result.stdout);
	}

	async noJobContainers(
		allocations: ReadonlySet<string> = this.allocations
	): Promise<void> {
		for (const allocation of allocations) {
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

	async verifyDisposed(
		allocations: ReadonlySet<string> = this.allocations
	): Promise<void> {
		await this.noJobContainers(allocations);

		for (const allocation of allocations) {
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

	async volumeFile(command: string, filename: string): Promise<string> {
		const [volume] = this.allocations;

		if (volume === undefined) {
			throw new Error('Expected an open Docker workspace.');
		}

		return this.docker([
			'run',
			'--rm',
			'--pull=never',
			'--network=none',
			'--read-only',
			'--cap-drop=ALL',
			'--user=65534:65534',
			'--mount',
			`type=volume,source=${volume},target=/workspace,readonly`,
			DOCKER_IMAGE,
			command,
			...(command === 'stat' ? ['-c', '%s'] : []),
			'/workspace/' + filename
		]);
	}

	contract(policy: SandboxPolicy): SandboxProviderTestFixture {
		const cwd = '/workspace/nested';

		return {
			configuration: this.config,
			hostWorkspace: this.workspace,
			find: [
				{
					request: { pattern: '*.txt', limit: 1 },
					result: { paths: ['source.txt'], truncated: false }
				},
				{
					request: { pattern: '*', limit: 1 },
					result: { paths: ['escape'], truncated: true }
				},
				{
					request: { pattern: 'nested' },
					result: { paths: ['nested/'], truncated: false }
				}
			],
			grep: [
				{
					request: {
						pattern: 'ORIGIN.L',
						ignoreCase: true,
						glob: '*.txt',
						limit: 1
					},
					result: {
						matches: [
							{
								path: 'source.txt',
								line: 1,
								text: 'original',
								before: [],
								after: []
							}
						],
						truncated: false
					}
				},
				{
					request: { path: 'source.txt', pattern: '.', literal: true },
					result: { matches: [], truncated: false }
				}
			],
			write: {
				directory: 'new/sub',
				path: 'new/sub/file',
				read: async () =>
					new Uint8Array(
						Buffer.from(
							await this.volumeFile('base64', 'new/sub/file'),
							'base64'
						)
					)
			},
			list: {
				path: '.',
				stat: async () => ({
					kind: 'directory' as const,
					size: Number(await this.volumeFile('stat', '.'))
				}),
				entries: [
					{ name: 'nested', kind: 'directory' },
					{ name: 'source.txt', kind: 'file' },
					{ name: 'escape', kind: 'symlink' }
				]
			},
			read: {
				path: 'source.txt',
				bytes: encode('original'),
				missingPath: 'missing-file'
			},
			visibility: nodeVisibilityProbe(
				this.workspace,
				'source.txt',
				'/usr/local/bin/node'
			),
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
			concurrentJob: {
				request: {
					kind: 'argv',
					executable: '/usr/local/bin/node',
					args: [
						'--input-type=module',
						'-e',
						`import {existsSync,readFileSync,writeFileSync} from 'node:fs';
import {setTimeout} from 'node:timers/promises';
writeFileSync("/tmp/peer-ready","");
process.stdout.write("ready");
while (!existsSync("/tmp/response")) await setTimeout(10);
process.stdout.write(readFileSync("/tmp/response"));`
					]
				},
				ready: encode('ready'),
				release: async (bytes, context) => {
					const peer = await this.#waitingPeer(context);

					if (!peer) {
						throw new Error('Expected one waiting Docker peer.');
					}

					await this.docker(
						[
							'exec',
							peer,
							'/bin/sh',
							'-ec',
							'printf %s "$1" | base64 -d > /tmp/pending && mv /tmp/pending /tmp/response',
							'release',
							Buffer.from(bytes).toString('base64')
						],
						context
					);
				}
			},
			policyEffects: {
				'read-only': (backend) =>
					Promise.resolve({
						permitted: sourceRead,
						denied: {
							request: {
								kind: 'shell',
								dialect: 'sh',
								command: '{ printf changed > source.txt; } 2>/dev/null'
							},
							exit: { kind: 'code', code: 2 },
							stdout: encode(''),
							stderr: encode('')
						},
						file: { path: '/workspace/source.txt', error: 'denied' },
						observe: async () => {
							const data = await this.docker([
								'run',
								'--rm',
								'--pull=never',
								'--network=none',
								'--cap-drop=ALL',
								'--user=65534:65534',
								'--read-only',
								'--mount',
								'type=volume,source=' +
									backend.id +
									',target=/workspace,readonly',
								DOCKER_IMAGE,
								'sh',
								'-c',
								'stat -c "%a %h" /workspace/source.txt && base64 -w0 /workspace/source.txt'
							]);
							const [metadata, bytes] = data.trim().split('\n', 2);

							if (!metadata || !bytes) {
								throw new Error('Missing independent Docker file metadata.');
							}

							const [mode = '', links] = metadata.split(' ', 2);

							return {
								kind: 'file',
								mode: Number.parseInt(mode, 8),
								links: Number(links),
								content: Buffer.from(bytes, 'base64')
							};
						}
					}),
				'denied-network': async () => {
					const address = await this.#networkAddress();

					return {
						permitted: sourceRead,
						denied: {
							request: {
								kind: 'argv',
								executable: '/usr/local/bin/node',
								args: [
									'--input-type=module',
									'-e',
									NETWORK_PROBE,
									'http://' + address + ':8080/'
								]
							},
							exit: { kind: 'code', code: 1 },
							stdout: encode(''),
							stderr: encode('')
						},
						observe: async () => ({
							kind: 'listener',
							connections: Number(
								await this.docker([
									'exec',
									this.server,
									'/usr/local/bin/node',
									'--input-type=module',
									'-e',
									"const response = await fetch('http://127.0.0.1:8080/count'); process.stdout.write(await response.text());"
								])
							)
						})
					};
				},
				'late-special-file': async () => {
					const endpoint = await this.socketEndpoint();
					let connections = 0;
					const server = createServer((peer) => {
						connections++;
						peer.destroy();
					});

					this.#localListener = server;
					server.listen(endpoint);
					await once(server, 'listening');

					const control = connect(endpoint);

					await once(control, 'close');

					return {
						permitted: sourceRead,
						denied: {
							request: {
								kind: 'argv',
								executable: '/usr/local/bin/node',
								args: [
									'-e',
									"const peer = require('node:net').connect('/workspace/s'); peer.on('error', error => { if (!['ENOENT','EPERM','EACCES'].includes(error.code)) throw error; process.exitCode=1; });"
								]
							},
							exit: { kind: 'code', code: 1 },
							stdout: encode(''),
							stderr: encode('')
						},
						file: { path: '/workspace/s', error: 'absent' },
						observe: () => Promise.resolve({ kind: 'listener', connections })
					};
				}
			},
			peerProcess: sourceRead,
			verifyAllocationDisposed: (backend) =>
				this.verifyDisposed(new Set([backend.id])),
			cancellation: {
				request: cancellationRequest,
				after: sourceRead,
				ready: encode('ready'),
				verifyStopped: async () => {
					await this.#waitingPeer();
				}
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
			try {
				await this.#localListener?.[Symbol.asyncDispose]();
			} finally {
				await Promise.all([
					rm(this.#directory, { recursive: true, force: true }),
					...(this.#socketDirectory
						? [rm(this.#socketDirectory, { recursive: true, force: true })]
						: [])
				]);
			}
		}
	}
}
