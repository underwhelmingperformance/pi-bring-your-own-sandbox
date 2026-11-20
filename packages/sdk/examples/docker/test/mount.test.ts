import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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

import { expect, it } from 'vitest';

import { connectHostReplacements } from '../src/host-replacements.js';
import { DOCKER_IMAGE } from '../src/image.js';
import { ALLOCATION_LABEL } from '../src/resources.js';

import { DockerFixture } from './fixture.js';

it
	.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')
	.each(['read-only', 'read-write'])(
	'serves a %s host workspace after dropping mount privileges and closing the control channel',
	async (mode) => {
		const fixture = await DockerFixture.create();
		const allocation = 'byos-mount-' + randomUUID();
		const label = ALLOCATION_LABEL + '=' + allocation;
		const binary = path.join(fixture.workspace, '..', 'mount-check');

		const staging = path.join(fixture.workspace, '..', 'staging');
		const isHostReplacements =
			process.platform === 'darwin' && mode === 'read-write';
		let closeHost: (() => Promise<void>) | undefined;

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
			await fixture.docker(['volume', 'create', '--label', label, allocation]);

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

			const owner = await stat(fixture.workspace);

			if (isHostReplacements) {
				await mkdir(staging, { mode: 0o700 });
			}

			const credentials = String(owner.uid) + ':' + String(owner.gid);

			await fixture.docker([
				'run',
				'--rm',
				'--pull=never',
				'--network=none',
				'--cap-drop=ALL',
				'--cap-add=CHOWN',
				'--mount',
				'type=volume,source=' + allocation + ',target=/control',
				DOCKER_IMAGE,
				'chown',
				credentials,
				'/control'
			]);
			await fixture.docker([
				'run',
				'--detach',
				'--name',
				allocation,
				...common,
				'--user=' + credentials,
				'--mount',
				'type=bind,source=' +
					fixture.workspace +
					',target=/backing' +
					(mode === 'read-only' ? ',readonly' : ''),
				...(isHostReplacements
					? ['--mount', 'type=bind,source=' + staging + ',target=/staging']
					: []),
				DOCKER_IMAGE,
				...(isHostReplacements ? ['serve-host'] : ['serve', mode])
			]);

			try {
				await fixture.docker([
					'exec',
					allocation,
					'/usr/bin/timeout',
					'5',
					'/bin/sh',
					'-c',
					'while [ ! -S /control/service ]; do sleep 0.05; done'
				]);
			} catch (error) {
				const logs = await fixture.docker(['logs', allocation]);

				throw new Error('The mount service did not start. ' + logs, {
					cause: error
				});
			}

			if (isHostReplacements) {
				closeHost = await connectHostReplacements(
					fixture.config,
					allocation,
					fixture.workspace,
					staging
				);
			}

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

			const security = await fixture.docker([
				'info',
				'--format',
				'{{json .SecurityOptions}}'
			]);
			const options: unknown = JSON.parse(security);

			if (!Array.isArray(options)) {
				throw new TypeError('Docker did not return its security options.');
			}

			await writeFile(
				path.join(fixture.workspace, 'source.txt'),
				'after service startup'
			);

			if (mode === 'read-write') {
				const oversized = path.join(fixture.workspace, 'truncate.txt');

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
				...(options.includes('name=apparmor')
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
						mode
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
					mode: 0o600
				});
			}

			const helper = await readFile(
				new URL('../src/file-helper.ts', import.meta.url),
				'utf8'
			);
			const sourcePath = '/workspace/source.txt';
			const result = await fixture.docker([
				...mounted,
				'/bin/sh',
				'-ec',
				`status=0
printf %s "$3" | /usr/local/bin/node --input-type=module-typescript --eval "$1" -- writeFile "$2" 1024 "\${#3}" || status=$?
printf '%s\n' "$status"
/usr/local/bin/node --input-type=module-typescript --eval "$1" -- readFile "$2" 1024`,
				'helper',
				helper,
				sourcePath,
				'tool edit'
			]);
			const expected =
				mode === 'read-write' ? 'tool edit' : 'after service startup';

			expect({ result, host: await readFile(source, 'utf8') }).toStrictEqual({
				result: (mode === 'read-write' ? '0' : '41') + '\n' + expected,
				host: expected
			});

			const zero = '0000000000000000';

			expect(JSON.parse(output)).toStrictEqual({
				initial: 'after service startup',
				listedSource: true,
				listedStage: false,
				denied: true,
				...(mode === 'read-only' && { createDenied: true }),
				...(mode === 'read-write' && {
					renamedDenied: true,
					renamedTruncateDenied: true,
					replacedTruncateDenied: true,
					linkedWriteDenied: true,
					linkedTruncateDenied: true,
					aliasWriteDenied: true,
					aliasTruncateDenied: true,
					previousSave: 'host contents',
					createChecks: {
						limit: true,
						reserved: true,
						unlink: true,
						removeDirectory: true,
						nestedCreate: true
					},
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
				await closeHost?.();
			} finally {
				await fixture.cleanup();
			}
		}
	},
	210_000
);
