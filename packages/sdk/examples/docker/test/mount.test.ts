import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { link, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { expect, it } from 'vitest';

import { DOCKER_IMAGE } from '../src/image.js';
import { ALLOCATION_LABEL } from '../src/resources.js';

import { DockerFixture } from './fixture.js';

it.skipIf(process.env['BYOS_DOCKER_TESTS'] !== '1')(
	'reads a mediated file after dropping mount privileges and closing the control channel',
	async () => {
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

			await fixture.docker([
				'run',
				'--detach',
				'--name',
				allocation,
				...common,
				'--mount',
				'type=bind,source=' + fixture.workspace + ',target=/backing,readonly',
				DOCKER_IMAGE,
				'serve'
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

			const output = await fixture.docker([
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
				'/usr/local/bin/node',
				'--input-type=module',
				'-e',
				`import { existsSync, readFileSync } from 'node:fs';
const status = Object.fromEntries(readFileSync('/proc/self/status', 'utf8')
  .split(String.fromCharCode(10)).map(line => line.split(':').map(value => value.trim())));
console.log(JSON.stringify({
  file: readFileSync('/workspace/source.txt', 'utf8'),
  backing: existsSync('/backing/source.txt'), alias: existsSync('/workspace/alias'),
  ids: [status.Uid, status.Gid].map(ids => ids.split(/\\s+/).map(Number)), groups: status.Groups,
  device: existsSync('/dev/fuse'), socket: existsSync('/control/service'),
  privileges: Object.fromEntries(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs']
    .map(key => [key, status[key]]))
}));`
			]);
			const zero = '0000000000000000';

			expect(JSON.parse(output)).toStrictEqual({
				file: 'after service startup',
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
