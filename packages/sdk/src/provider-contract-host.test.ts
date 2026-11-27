import {
	mkdir,
	mkdtemp,
	readFile,
	realpath,
	rm,
	stat,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineSandboxProviderTests } from 'pi-bring-your-own-sandbox/testing';
import { expect } from 'vitest';

import { nodeVisibilityProbe } from '../../../test-support/node-visibility-probe.js';

import { firstOpenProfile } from './fixtures/profile-fixture.js';
import { fixtureProvider } from './fixtures/register-provider.js';
import { openPassthrough, probePassthrough } from './passthrough.js';
import { unrestrictedPolicy } from './policy-model.js';
import { profileCapabilities } from './validation.js';

const hostProfile = await probePassthrough(process.cwd());

const provider = fixtureProvider<undefined>({
	id: 'fixture.host',
	label: 'Host provider contract scenario without isolation',
	profiles: { open: [hostProfile.profile], copy: [] },
	validateConfig: () => {
		return;
	},
	async open(request, context) {
		const backend = await openPassthrough(
			request.hostWorkspace,
			context,
			hostProfile,
			request.paths
		);

		return request.hostUserDataRoots === undefined
			? backend
			: { ...backend, hostUserDataRoots: request.hostUserDataRoots };
	}
});

defineSandboxProviderTests({
	workspaceVisibility: 'shared',
	label: 'compiled contract suite against host processes and files',
	provider,
	capabilities: {
		...profileCapabilities(firstOpenProfile(provider)),
		operations: [
			'exec',
			'files.read',
			'files.write',
			'files.list',
			'search.find',
			'search.grep'
		],
		shells: ['sh']
	},
	async createFixture() {
		const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-contract-'));
		const directory = await realpath(temporary);
		const seed = new Uint8Array([0, 255, 13, 10]);

		await writeFile(path.join(directory, 'seed'), seed);
		await mkdir(path.join(directory, 'search'));
		await writeFile(
			path.join(directory, 'search', 'fixture.txt'),
			'before\nneedle\nafter\n'
		);

		const directoryStat = await stat(path.join(directory, 'search'));
		const child =
			'require("node:fs").writeFileSync("job.pid",String(process.pid));process.stdout.write("ready\\n");setInterval(()=>{},1000)';
		const parent = `require('node:child_process').spawn(process.execPath,['-e',${JSON.stringify(child)}],{stdio:['ignore','inherit','inherit']});setInterval(()=>{},1000)`;

		const verifyStopped = async () => {
			const pid = Number(
				await readFile(path.join(directory, 'job.pid'), 'utf8')
			);

			expect(pid).toBeGreaterThan(0);
			expect(() => process.kill(pid, 0)).toThrow(
				expect.objectContaining({ code: 'ESRCH' })
			);
		};

		return {
			configuration: undefined,
			hostWorkspace: directory,
			visibility: nodeVisibilityProbe(directory, 'seed', process.execPath),
			policy: unrestrictedPolicy,
			processes: [
				{
					request: {
						kind: 'argv',
						executable: process.execPath,
						args: [
							'-e',
							'process.stdout.write(JSON.stringify({args:process.argv.slice(1),cwd:process.cwd(),value:process.env.BYOS_CONTRACT_VALUE}));process.stderr.write("error");process.exitCode=7',
							'$HOME',
							'; exit 99'
						],
						env: { BYOS_CONTRACT_VALUE: 'target value' }
					},
					exit: { kind: 'code', code: 7 },
					stdout: new TextEncoder().encode(
						JSON.stringify({
							args: ['$HOME', '; exit 99'],
							cwd: directory,
							value: 'target value'
						})
					),
					stderr: new TextEncoder().encode('error')
				}
			],
			shells: {
				sh: {
					request: {
						kind: 'shell',
						dialect: 'sh',
						command: 'printf shell; printf error >&2; exit 7'
					},
					exit: { kind: 'code', code: 7 },
					stdout: new TextEncoder().encode('shell'),
					stderr: new TextEncoder().encode('error')
				}
			},
			read: { path: 'seed', bytes: seed, missingPath: 'absent' },
			write: {
				directory: 'nested/child',
				path: 'nested/child/file',
				read: async () =>
					new Uint8Array(
						await readFile(path.join(directory, 'nested/child/file'))
					)
			},
			list: {
				path: 'search',
				stat: { kind: 'directory', size: directoryStat.size },
				entries: [{ name: 'fixture.txt', kind: 'file' }]
			},
			find: [
				{
					request: { path: 'search', pattern: '*.txt', limit: 1 },
					result: { paths: ['fixture.txt'], truncated: false }
				}
			],
			grep: [
				{
					request: {
						path: 'search',
						pattern: 'needle',
						literal: true,
						context: 1,
						limit: 1
					},
					result: {
						matches: [
							{
								path: 'fixture.txt',
								line: 2,
								text: 'needle',
								before: ['before'],
								after: ['after']
							}
						],
						truncated: false
					}
				}
			],
			cancellation: {
				request: {
					kind: 'argv',
					executable: process.execPath,
					args: ['-e', parent]
				},
				ready: new TextEncoder().encode('ready\n'),
				verifyStopped
			},
			verifyDisposed: async () => {
				try {
					await readFile(path.join(directory, 'job.pid'));
				} catch (error) {
					expect(error).toMatchObject({ code: 'ENOENT' });

					return;
				}

				await verifyStopped();
			},
			cleanup: () => rm(directory, { recursive: true, force: true })
		};
	}
});
