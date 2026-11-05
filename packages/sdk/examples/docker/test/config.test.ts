import { expect, it } from 'vitest';

import { dockerConfig } from '../src/config.js';

it('validates explicit local paths and supplies Linux defaults without allocating resources', () => {
	expect({
		defaults: dockerConfig({}),
		custom: dockerConfig({
			executable: '/custom/docker',
			socketPath: '/custom/docker.sock'
		})
	}).toStrictEqual({
		defaults: {
			executable: '/usr/bin/docker',
			socketPath: '/var/run/docker.sock'
		},
		custom: { executable: '/custom/docker', socketPath: '/custom/docker.sock' }
	});
});

it.each([
	undefined,
	[],
	{ socketPath: 'relative' },
	{ socketPath: 'tcp://remote:2375' },
	{ executable: 'docker' },
	{ executable: '/docker\0other' },
	{ socketPath: '/docker\0other' },
	{ extra: true }
])('rejects malformed or remote connection settings: %j', (input) => {
	expect(() => dockerConfig(input)).toThrow(
		expect.objectContaining({ name: 'InvalidSandboxConfigError' })
	);
});
