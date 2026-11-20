import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, readFile, rename, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

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
				DOCKER_IMAGE,
				'serve',
				mode
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
			await link(fixture.outside, path.join(fixture.workspace, 'alias'));

			const workload = fixture.docker([
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
				mode,
				'/usr/local/bin/node',
				'--input-type=module-typescript',
				'-e',
				await readFile(new URL('mount/workload.ts', import.meta.url), 'utf8'),
				mode
			]);
			const source = path.join(fixture.workspace, 'source.txt');
			const retained = path.join(fixture.workspace, '..', 'retained');
			const observe = async () => {
				const deadline = Date.now() + 45_000;

				while (Date.now() < deadline) {
					if ((await readFile(source, 'utf8')) === 'workload edit') {
						const replacement = path.join(fixture.workspace, 'replacement');

						await writeFile(replacement, 'host replacement');
						await link(source, retained);
						await rename(replacement, source);
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
				workload,
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
				expect(await readFile(retained, 'utf8')).toBe('workload edit');
			}

			const zero = '0000000000000000';

			expect(JSON.parse(output)).toStrictEqual({
				initial: 'after service startup',
				denied: true,
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
			await fixture.cleanup();
		}
	},
	150_000
);
