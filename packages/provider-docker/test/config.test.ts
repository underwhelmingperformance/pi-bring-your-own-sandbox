import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { dockerConfig, resolveDockerConfig } from '../src/config.js';
import type { DockerConfig } from '../src/contracts.js';

import { writeFakeDockerCli } from './fixtures/fake-cli.js';

afterEach(() => {
	vi.unstubAllEnvs();
});

/**
Creates a temporary directory with an empty workspace, and a discovery context
that records diagnostics. Disposing the result removes the directory.
*/
async function scratch() {
	const temporary = await mkdtemp(path.join(tmpdir(), 'byos-docker-config-'));
	const directory = await realpath(temporary);
	const workspace = path.join(directory, 'workspace');
	const diagnostics: string[] = [];

	await mkdir(workspace);

	return {
		directory,
		diagnostics,
		context: {
			workspace,
			signal: AbortSignal.timeout(10_000),
			reportWarning(diagnostic: string) {
				diagnostics.push(diagnostic);
			}
		},
		[Symbol.asyncDispose]: () => rm(directory, { recursive: true, force: true })
	};
}

it('validates explicit local paths without allocating resources', () => {
	expect(
		dockerConfig({
			executable: '/custom/docker',
			socketPath: '/custom/docker.sock'
		})
	).toStrictEqual({
		executable: '/custom/docker',
		socketPath: '/custom/docker.sock'
	});
});

it.each([
	undefined,
	[],
	{},
	{ executable: '/usr/bin/docker' },
	{ socketPath: '/var/run/docker.sock' },
	{ executable: '/usr/bin/docker', socketPath: 'relative' },
	{ executable: '/usr/bin/docker', socketPath: 'tcp://remote:2375' },
	{ executable: 'docker', socketPath: '/var/run/docker.sock' },
	{ executable: '/docker\0other', socketPath: '/var/run/docker.sock' },
	{ executable: '/usr/bin/docker', socketPath: '/docker\0other' },
	{
		executable: '/usr/bin/docker',
		socketPath: '/var/run/docker.sock',
		extra: true
	}
])(
	'rejects incomplete, malformed or remote connection settings: %j',
	(input) => {
		expect(() => dockerConfig(input)).toThrow(
			expect.objectContaining({ name: 'InvalidSandboxConfigError' })
		);
	}
);

it('finds the CLI file on PATH outside the workspace and asks it for the current socket', async () => {
	await using test = await scratch();

	const { directory } = test;
	const planted = await writeFakeDockerCli(
		path.join(directory, 'workspace', 'bin')
	);
	const installed = await writeFakeDockerCli(path.join(directory, 'tools'));
	const shadowing = path.join(directory, 'shadowing');

	await mkdir(path.join(shadowing, 'docker'), { recursive: true });
	vi.stubEnv(
		'PATH',
		[
			'relative',
			path.dirname(planted),
			path.join(directory, 'missing'),
			shadowing,
			path.dirname(installed)
		].join(path.delimiter)
	);
	vi.stubEnv('BYOS_TEST_ENDPOINT', 'unix:///discovered/docker.sock');

	expect({
		config: await resolveDockerConfig({}, test.context),
		diagnostics: test.diagnostics
	}).toStrictEqual({
		config: { executable: installed, socketPath: '/discovered/docker.sock' },
		diagnostics: []
	});
});

it.each<{
	readonly name: string;
	readonly scenario: (installed: string) => {
		readonly path: string;
		readonly input: Partial<DockerConfig>;
		readonly expected: DockerConfig;
	};
}>([
	{
		name: 'both settings without running the CLI',
		scenario: () => ({
			path: '',
			input: {
				executable: '/custom/docker',
				socketPath: '/custom/docker.sock'
			},
			expected: {
				executable: '/custom/docker',
				socketPath: '/custom/docker.sock'
			}
		})
	},
	{
		name: 'the executable and asks it for the socket',
		scenario: (installed) => ({
			path: '',
			input: { executable: installed },
			expected: { executable: installed, socketPath: '/discovered/docker.sock' }
		})
	},
	{
		name: 'the socket',
		scenario: (installed) => ({
			path: path.dirname(installed),
			input: { socketPath: '/custom/docker.sock' },
			expected: { executable: installed, socketPath: '/custom/docker.sock' }
		})
	}
])('keeps explicit $name', async ({ scenario }) => {
	await using test = await scratch();

	const {
		path: search,
		input,
		expected
	} = scenario(await writeFakeDockerCli(path.join(test.directory, 'tools')));

	vi.stubEnv('PATH', search);
	vi.stubEnv('BYOS_TEST_ENDPOINT', 'unix:///discovered/docker.sock');

	expect({
		config: await resolveDockerConfig(input, test.context),
		diagnostics: test.diagnostics
	}).toStrictEqual({ config: expected, diagnostics: [] });
});

it.each([
	{
		name: 'no CLI on PATH',
		input: {},
		isOnPath: false,
		endpoint: 'unix:///discovered/docker.sock',
		message:
			'Install the Docker CLI on PATH or set executable to its absolute path.'
	},
	{
		name: 'a relative explicit executable',
		input: { executable: 'docker' },
		isOnPath: true,
		endpoint: 'unix:///discovered/docker.sock',
		message: 'Set executable and socketPath to absolute local paths.'
	},
	{
		name: 'a failing CLI',
		input: {},
		isOnPath: true,
		endpoint: '',
		message:
			'The Docker CLI did not report its current context. Select a context or set socketPath.'
	},
	{
		name: 'a TCP endpoint',
		input: {},
		isOnPath: true,
		endpoint: 'tcp://remote:2375',
		message:
			'The current Docker context does not use a local Unix socket. Select a local context or set socketPath.'
	},
	{
		name: 'a relative socket',
		input: {},
		isOnPath: true,
		endpoint: 'unix://docker.sock',
		message:
			'The current Docker context does not use a local Unix socket. Select a local context or set socketPath.'
	}
])('rejects discovery with $name', async (scenario) => {
	await using test = await scratch();

	const installed = await writeFakeDockerCli(
		path.join(test.directory, 'tools')
	);

	vi.stubEnv('PATH', scenario.isOnPath ? path.dirname(installed) : '');
	vi.stubEnv('BYOS_TEST_ENDPOINT', scenario.endpoint);

	await expect(
		resolveDockerConfig(scenario.input, test.context)
	).rejects.toMatchObject({
		name: 'InvalidSandboxConfigError',
		operation: 'configure',
		providerId: 'example.docker',
		cause: { name: 'TypeError', message: scenario.message }
	});
	expect(test.diagnostics).toStrictEqual([`Docker: ${scenario.message}`]);
});
