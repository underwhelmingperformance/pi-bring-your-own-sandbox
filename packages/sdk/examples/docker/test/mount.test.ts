import { execFile } from 'node:child_process';
import {
	link,
	mkdir,
	readFile,
	rename,
	stat,
	truncate,
	writeFile
} from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { SandboxPermissionDeniedError } from 'pi-bring-your-own-sandbox/api';
import { expect, it, vi } from 'vitest';

import { createSandbox } from '../../../src/facade.js';
import { TestBackendOwner } from '../../../src/fixtures/backend-owner.js';
import { DOCKER_IMAGE } from '../src/image.js';
import { attachDockerWorkspace } from '../src/provider.js';
import { ALLOCATION_LABEL, DockerResources } from '../src/resources.js';
import { DockerWorkspaceService } from '../src/workspace-service.js';

import { DockerFixture, operationContext } from './fixture.js';

it
	.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')
	.each(['read-only', 'read-write'] as const)(
	'serves a %s host workspace after dropping mount privileges and closing the control channel',
	async (mode) => {
		const fixture = await DockerFixture.create();
		const client = fixture.providerClient();
		const isHostReplacements =
			process.platform === 'darwin' && mode === 'read-write';
		const resources = new DockerResources(
			client,
			fixture.config.socketPath,
			isHostReplacements ? path.dirname(fixture.workspace) : undefined
		);
		const allocation = resources.volume;
		const label = ALLOCATION_LABEL + '=' + allocation;
		const binary = path.join(fixture.workspace, '..', 'mount-check');
		let service: DockerWorkspaceService | undefined;

		fixture.allocations.add(allocation);

		try {
			const architecture = await fixture.docker([
				'version',
				'--format',
				'{{.Server.Arch}}'
			]);
			const arch = architecture.trim();

			await promisify(execFile)(
				'go',
				['build', '-mod=readonly', '-trimpath', '-o', binary, '.'],
				{
					cwd: fileURLToPath(new URL('mount/', import.meta.url)),
					env: {
						...process.env,
						GOOS: 'linux',
						GOARCH: arch,
						CGO_ENABLED: '0'
					},
					timeout: 90_000
				}
			);
			service = await DockerWorkspaceService.open(
				fixture.config,
				resources,
				{
					workspace: fixture.workspace,
					bootstrap: binary,
					access: mode,
					protectedPaths: isHostReplacements ? ['nested/policies/config'] : []
				},
				{
					...operationContext(),
					reportRecovery(recovery) {
						expect(recovery).toStrictEqual(resources.recovery);
					},
					confirmCleanup() {
						return;
					}
				}
			);

			const common = [
				'--pull=never',
				'--read-only',
				'--network=none',
				'--cap-drop=ALL',
				'--security-opt=no-new-privileges',
				'--pids-limit=32',
				'--memory=128m',
				'--label',
				label,
				'--mount',
				'type=volume,source=' + allocation + ',target=/control',
				'--mount',
				'type=bind,source=' + binary + ',target=/mount-check,readonly',
				'--entrypoint=/mount-check'
			];

			await fixture.docker([
				'exec',
				'--user=65534:65534',
				allocation,
				'/usr/bin/timeout',
				'5',
				'/usr/bin/perl',
				'-MSocket',
				'-e',
				`socket(my $peer, AF_UNIX, SOCK_SEQPACKET, 0) or die $!;
connect($peer, sockaddr_un("/control/service")) or die $!;
shutdown($peer, 1);
my $count = sysread($peer, my $reply, 1);
die "unexpected mount acknowledgement" unless defined($count) && $count == 0;`
			]);
			await expect
				.poll(() => fixture.docker(['logs', allocation]), { timeout: 5000 })
				.toContain('mount request from uid 65534: permission denied');

			await writeFile(
				path.join(fixture.workspace, 'source.txt'),
				'after service startup'
			);

			if (mode === 'read-write') {
				const oversized = path.join(fixture.workspace, 'truncate.txt');

				await writeFile(path.join(fixture.workspace, 'append.txt'), 'initial');

				await mkdir(path.join(fixture.workspace, '.pi'));
				await writeFile(
					path.join(fixture.workspace, '.pi/settings'),
					'protected'
				);
				await link(
					path.join(fixture.workspace, '.pi/settings'),
					path.join(fixture.workspace, 'settings-alias')
				);
				await writeFile(
					path.join(fixture.workspace, 'formatter.txt'),
					'unformatted source'
				);
				await writeFile(oversized, '');
				await writeFile(
					path.join(fixture.workspace, 'concurrent.txt'),
					'first save'
				);
				await truncate(oversized, 16 * 1024 * 1024 + 1);
			}

			await writeFile(
				path.join(fixture.workspace, '.pi-byos-write-fixture'),
				'host file'
			);
			await link(fixture.outside, path.join(fixture.workspace, 'alias'));

			const mounted = [
				'run',
				'--rm',
				...common,
				...(service.hasAppArmor
					? ['--security-opt=apparmor=byos-mount-probe']
					: []),
				'--device=/dev/fuse',
				'--cap-add=SYS_ADMIN',
				'--cap-add=SETPCAP',
				'--cap-add=SETUID',
				'--cap-add=SETGID',
				'--tmpfs=/workspace:rw,nosuid,nodev',
				DOCKER_IMAGE,
				'mount',
				mode
			];
			const finished = new AbortController();
			const workload = async () => {
				try {
					return await fixture.docker([
						...mounted,
						'/usr/local/bin/node',
						'--input-type=module-typescript',
						'-e',
						await readFile(
							new URL('mount/workload.ts', import.meta.url),
							'utf8'
						),
						mode,
						isHostReplacements ? 'host' : 'guest'
					]);
				} finally {
					finished.abort();
				}
			};

			const source = path.join(fixture.workspace, 'source.txt');
			const retained = path.join(fixture.workspace, '..', 'retained');
			const observe = async () => {
				const deadline = Date.now() + 45_000;

				while (!finished.signal.aborted && Date.now() < deadline) {
					if ((await readFile(source, 'utf8')) === 'workload edit') {
						const replacement = path.join(fixture.workspace, 'replacement');

						await writeFile(replacement, 'host replacement');
						await writeFile(
							path.join(fixture.workspace, 'append.txt'),
							'initial and extended'
						);
						await rename(
							path.join(fixture.workspace, 'editor-save'),
							path.join(fixture.workspace, 'renamed-save')
						);
						expect(
							await readFile(
								path.join(fixture.workspace, 'formatter.txt'),
								'utf8'
							)
						).toBe('formatted');
						await link(
							path.join(fixture.workspace, 'formatter.txt'),
							path.join(fixture.workspace, '.pi/held')
						);
						await link(source, retained);
						await rename(replacement, source);
						await writeFile(replacement, 'host contents');
						await rename(
							replacement,
							path.join(fixture.workspace, 'concurrent.txt')
						);
						await writeFile(
							path.join(fixture.workspace, 'host-ready'),
							'ready'
						);

						return;
					}

					await delay(10);
				}

				throw new Error('The host did not observe the workload write.');
			};

			const [job, observed] = await Promise.allSettled([
				workload(),
				mode === 'read-write' ? observe() : undefined
			]);

			if (job.status === 'rejected') {
				const detail = await fixture.docker(['logs', allocation]);

				throw new Error('The mounted job failed. ' + detail, {
					cause: job.reason
				});
			}

			if (observed.status === 'rejected') {
				throw observed.reason;
			}

			const output = job.value;

			if (mode === 'read-write') {
				const truncated = await readFile(
					path.join(fixture.workspace, 'truncate.txt')
				);

				expect(truncated).toStrictEqual(Buffer.from([97, 98, 0, 0]));

				const saved = path.join(fixture.workspace, 'renamed-save');
				const attributes = await stat(saved);
				const directory = await stat(path.join(fixture.workspace, 'nested'));

				expect({
					directory: directory.isDirectory(),
					settings: await readFile(
						path.join(fixture.workspace, '.pi/settings'),
						'utf8'
					),
					held: await readFile(
						path.join(fixture.workspace, '.pi/held'),
						'utf8'
					),
					retained: await readFile(retained, 'utf8'),
					concurrent: await readFile(
						path.join(fixture.workspace, 'concurrent.txt'),
						'utf8'
					),
					renamed: await readFile(saved, 'utf8'),
					mode: attributes.mode & 0o777
				}).toStrictEqual({
					directory: true,
					settings: 'protected',
					held: 'formatted',
					retained: 'workload edit',
					concurrent: 'workload replacement',
					renamed: 'workload replacement',
					mode: isHostReplacements ? 0o644 : 0o600
				});
			}

			const backend = await attachDockerWorkspace(client, mode, service);
			const sandbox = createSandbox(new TestBackendOwner(backend));

			try {
				const build = path.join(fixture.workspace, 'build.ts');
				const program = (value: string) =>
					`const value: string = ${JSON.stringify(value)}; process.stdout.write(value);`;
				const edit = Buffer.from(program('SDK build'));

				await writeFile(build, program('host build'));

				if (mode === 'read-write') {
					await sandbox.files.writeFile('build.ts', edit);
					await expect(
						sandbox.files.writeFile('settings-alias', edit)
					).rejects.toBeInstanceOf(SandboxPermissionDeniedError);
				} else {
					await expect(
						sandbox.files.writeFile('build.ts', edit)
					).rejects.toBeInstanceOf(SandboxPermissionDeniedError);
				}

				if (isHostReplacements) {
					await sandbox.files.mkdir('nested/policies');
					await sandbox.files.mkdir('nested/output');
					await sandbox.files.writeFile('nested/output/draft.txt', edit);

					const save = await sandbox.exec({
						kind: 'argv',
						executable: '/usr/local/bin/node',
						args: [
							'-e',
							`
const fs = require('node:fs');
process.umask(0);
fs.writeFileSync('nested/output/.save', 'editor contents', {mode: 0o775});
require('node:child_process').execFileSync('/bin/mv', ['nested/output/.save', 'nested/output/draft.txt']);
fs.mkdirSync('nested/temporary');
fs.writeFileSync('nested/temporary/build.log', 'ready');
fs.renameSync('nested/temporary', 'nested/renamed');
fs.unlinkSync('nested/renamed/build.log');
fs.rmdirSync('nested/renamed');
for (const target of ['.pi/settings', '.envrc', '.ENVRC', '.Git', '.direnv', '.vscode', '.idea', '.devcontainer', 'nested/.git', 'nested/policies/config', 'settings-alias']) {
  try { fs.renameSync('nested/output/draft.txt', target); }
  catch (error) { if (error.code === 'EACCES' || error.code === 'EPERM') continue; throw error; }
  throw new Error('A protected editor destination was writable.');
}
`
						]
					});

					const savedPath = path.join(
						fixture.workspace,
						'nested/output/draft.txt'
					);
					const metadata = await stat(savedPath);
					const referencePath = path.join(fixture.workspace, 'host-mode');

					await writeFile(referencePath, '', { mode: 0o775 });

					const hostMode = await stat(referencePath);

					expect({
						error: new TextDecoder().decode(save.stderr),
						exit: save.exit,
						mode: metadata.mode & 0o777,
						contents: await readFile(savedPath, 'utf8')
					}).toStrictEqual({
						error: '',
						exit: { kind: 'code', code: 0 },
						mode: hostMode.mode & 0o777,
						contents: 'editor contents'
					});
					await expect(
						stat(path.join(fixture.workspace, 'nested/temporary'))
					).rejects.toMatchObject({ code: 'ENOENT' });
				}

				const workerStatus = new TextDecoder().decode(
					await sandbox.files.readFile('/proc/self/status')
				);

				expect(
					workerStatus
						.split('\n')
						.filter((line) =>
							/^(?:Cap(?:Inh|Prm|Eff|Bnd|Amb)|NoNewPrivs):/u.test(line)
						)
				).toStrictEqual([
					...['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'].map(
						(field) => field + ':\t0000000000000000'
					),
					'NoNewPrivs:\t1'
				]);

				const shell = await sandbox.exec({
					kind: 'shell',
					dialect: 'bash',
					command:
						'/usr/local/bin/node --disable-warning=ExperimentalWarning --input-type=module-typescript < build.ts'
				});
				const expected = mode === 'read-write' ? 'SDK build' : 'host build';

				expect({ ...shell, durationMs: 0 }).toStrictEqual({
					exit: { kind: 'code', code: 0 },
					stdout: new TextEncoder().encode(expected),
					stderr: new Uint8Array(),
					omittedBytes: { stdout: 0, stderr: 0 },
					durationMs: 0
				});
				expect(await readFile(build, 'utf8')).toBe(program(expected));

				const replacement = path.join(fixture.workspace, 'editor-update');

				await writeFile(replacement, 'next editor save');
				await rename(replacement, build);
				expect(
					new TextDecoder().decode(await sandbox.files.readFile('build.ts'))
				).toBe('next editor save');
				expect(
					await sandbox.search.grep({
						path: 'build.ts',
						pattern: '^next .+ save$'
					})
				).toStrictEqual({
					matches: [
						{
							path: 'build.ts',
							line: 1,
							text: 'next editor save',
							before: [],
							after: []
						}
					],
					truncated: false
				});
			} finally {
				await backend.dispose(operationContext());
				service = undefined;

				if (resources.hostStaging !== undefined) {
					await expect(stat(resources.hostStaging)).rejects.toMatchObject({
						code: 'ENOENT'
					});
				}
			}

			if (isHostReplacements) {
				const failed = new DockerResources(
					client,
					fixture.config.socketPath,
					path.dirname(fixture.workspace)
				);
				const confirmCleanup = vi.fn();

				await expect(
					DockerWorkspaceService.open(
						fixture.config,
						failed,
						{
							workspace: fixture.workspace,
							bootstrap: binary,
							access: mode,
							protectedPaths: ['../outside']
						},
						{ ...operationContext(), reportRecovery: vi.fn(), confirmCleanup }
					)
				).rejects.toThrow('protected path');
				expect(confirmCleanup).toHaveBeenCalledOnce();

				if (failed.hostStaging === undefined) {
					throw new Error('Missing native staging path.');
				}

				await expect(stat(failed.hostStaging)).rejects.toMatchObject({
					code: 'ENOENT'
				});
			}

			await fixture.verifyDisposed();

			const zero = '0000000000000000';

			expect(JSON.parse(output)).toStrictEqual({
				initial: 'after service startup',
				listedSource: true,
				listedStage: false,
				denied: true,
				...(mode === 'read-only' && { createDenied: true }),
				...(mode === 'read-write' && {
					renamedDenied: true,
					staleReadDenied: true,
					appendedSize: Buffer.byteLength('initial and extended'),
					linkedReadDenied: true,
					renamedTruncateDenied: true,
					replacedTruncateDenied: true,
					linkedWriteDenied: true,
					linkedTruncateDenied: true,
					aliasWriteDenied: true,
					aliasTruncateDenied: true,
					previousSave: 'host contents',
					...(!isHostReplacements && {
						createChecks: {
							limit: true,
							reserved: true,
							unlink: true,
							removeDirectory: true,
							nestedCreate: true
						}
					}),
					oversizedDenied: true,
					sizes: {
						truncated: 0,
						written: Buffer.byteLength('workload edit'),
						readerSize: Buffer.byteLength('after service startup')
					}
				}),
				file:
					mode === 'read-write' ? 'host replacement' : 'after service startup',
				backing: false,
				alias: false,
				ids: [
					Array.from({ length: 4 }, () => 65_534),
					Array.from({ length: 4 }, () => 65_534)
				],
				groups: '',
				device: false,
				socket: false,
				privileges: {
					CapInh: zero,
					CapPrm: zero,
					CapEff: zero,
					CapBnd: zero,
					CapAmb: zero,
					NoNewPrivs: '1'
				}
			});
		} finally {
			try {
				await service?.dispose(operationContext());
			} finally {
				await fixture.cleanup();
			}
		}
	},
	210_000
);
