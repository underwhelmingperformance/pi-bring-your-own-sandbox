import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
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
		const binary = path.join(fixture.workspace, 'mount-check');

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
				'--memory=64m',
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
				DOCKER_IMAGE,
				'serve'
			]);
			await fixture.docker([
				'exec',
				allocation,
				'/usr/bin/timeout',
				'5',
				'/bin/sh',
				'-c',
				'while [ ! -S /control/service ]; do sleep 0.05; done'
			]);

			const output = await fixture.docker([
				'run',
				'--rm',
				...common,
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
  file: readFileSync('/workspace/probe', 'utf8'),
  uid: process.getuid(), gid: process.getgid(), groups: process.getgroups(),
  device: existsSync('/dev/fuse'), socket: existsSync('/control/service'),
  privileges: Object.fromEntries(['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs']
    .map(key => [key, status[key]]))
}));`
			]);
			const zero = '0000000000000000';

			expect(JSON.parse(output)).toStrictEqual({
				file: 'mediated\n',
				uid: 65_534,
				gid: 65_534,
				groups: [65_534],
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
