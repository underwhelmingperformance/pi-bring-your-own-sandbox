import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, it } from 'vitest';

import {
	add,
	packedArchive,
	project,
	retainedReleaseArchive,
	run
} from '../../../test-support/packages.js';

import { RpcProcess } from './fixtures/rpc-process.js';
import { isRecord } from './validation.js';

const repository = fileURLToPath(new URL('../../../', import.meta.url));
const sdk = fileURLToPath(new URL('../', import.meta.url));
const packageName = 'pi-bring-your-own-sandbox';
const revisions = [
	'caf09630558859d62c34b3242db865756b80bec3',
	'f42f166c11a64886efde257f28151747ca049f5b'
] as const;

const peerExtension = `
import { appendFile, readFile } from 'node:fs/promises';
import { createSandboxClient } from '${packageName}/consumer';
import { registerSandboxProvider } from '${packageName}/provider';
import sandboxTools from '${packageName}/pi-tools';

const directory = new URL('./node_modules/${packageName}/dist/', import.meta.url);
const { packageVersion, buildId } = JSON.parse(await readFile(new URL('protocol-build.json', directory), 'utf8'));
const { PROTOCOL_MAJOR: major, PROTOCOL_FEATURE_LEVEL: featureLevel } = await import(new URL('protocol-envelope.js', directory).href);
const { trace, label, isProvider } = JSON.parse(await readFile(new URL('peer.json', import.meta.url), 'utf8'));
const released = packageVersion === '1.0.0';
const providerId = 'fixture.release-restart';

export default function peer(pi) {
  const client = createSandboxClient(pi, import.meta.filename);

  if (released && isProvider) {
    const profile = {
      policy: { hostWorkspaceWrites: true, network: false, hostUserData: 'denied', hostSystemFiles: 'read-only' },
      capabilities: [], processKinds: ['shell'], shells: ['sh'], exitStatus: 'guaranteed', terminationScope: 'workload'
    };

    registerSandboxProvider(pi, import.meta.filename, {
      id: providerId,
      label: 'Release restart fixture',
      profiles: { open: [profile], copy: [] },
      create: () => ({
        configure: () => ({ configuration: undefined }),
        async open(request) {
          return {
            id: 'release-restart',
            workspace: { root: '/release-target', pathFlavor: 'posix', relationship: 'shared', defaultShell: 'sh' },
            profile: request.profile,
            policyDescription: 'In-memory restart test fixture',
            recovery: { kind: 'none' },
            async exec(command, context) {
              context.onOutput({ stream: 'stdout', data: Buffer.from('released provider saw ' + command.command) });
              return { kind: 'exited', exit: { kind: 'code', code: 0 } };
            },
            async dispose() {}
          };
        }
      })
    });
    sandboxTools(pi, import.meta.filename);
  }

  pi.on('session_start', async (_event, context) => {
    const provider = released ? (await client.get(context)).providerId : undefined;
    await appendFile(trace, JSON.stringify({ pid: process.pid, label, buildId, packageVersion, major, featureLevel, provider }) + '\\n');
  });
}
`;

async function pack(source: string, destination: string): Promise<string> {
	const result = await run(source, 'pnpm', [
		'pack',
		'--ignore-scripts',
		'--json',
		'--pack-destination',
		destination
	]);

	return packedArchive(result.stdout).filename;
}

async function archiveDraft(
	directory: string,
	revision: string
): Promise<string> {
	const source = path.join(directory, revision);
	const archive = source + '.tar';

	await mkdir(source);
	await run(repository, 'git', ['archive', '--output', archive, revision]);
	await run(source, 'tar', ['-xf', archive]);
	await run(source, 'pnpm', [
		'install',
		'--ignore-scripts',
		'--frozen-lockfile',
		'--prefer-offline'
	]);
	await run(source, 'pnpm', ['--filter', packageName, 'build']);

	return pack(path.join(source, 'packages/sdk'), source);
}

async function archiveBuildId(archive: string): Promise<string> {
	const result = await run(repository, 'tar', [
		'-xOf',
		archive,
		'package/dist/protocol-build.json'
	]);
	const identity: unknown = JSON.parse(result.stdout);

	if (!isRecord(identity) || typeof identity['buildId'] !== 'string') {
		throw new Error('The SDK archive did not report its build identity.');
	}

	return identity['buildId'];
}

async function readTrace(filename: string): Promise<unknown[]> {
	const contents = await readFile(filename, 'utf8');

	return contents
		.trim()
		.split('\n')
		.map((line): unknown => JSON.parse(line));
}

async function startPi(
	directory: string,
	extension: string,
	command?: string
): Promise<void> {
	const entry = fileURLToPath(
		import.meta.resolve('@earendil-works/pi-coding-agent')
	);
	const cli = path.join(path.dirname(entry), 'bundle', 'cli.js');
	const rpc = new RpcProcess(cli, directory, extension);

	try {
		await expect(rpc.send({ type: 'get_state' })).resolves.toMatchObject({
			success: true
		});

		if (command !== undefined) {
			await expect(
				rpc.send({ type: 'bash', command, excludeFromContext: false })
			).resolves.toMatchObject({
				success: true,
				data: {
					output: 'released provider saw ' + command,
					exitCode: 0,
					cancelled: false
				}
			});
		}
	} finally {
		await rpc.close();
	}
}

it.skipIf(process.env['BYOS_PACKAGE_TESTS'] !== '1')(
	'restarts Pi after replacing both historical protocol 1.0 drafts with the release',
	async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'byos-release-cutover-')
		);
		const installation = path.join(directory, 'installation');
		const trace = path.join(installation, 'trace.jsonl');
		const extension = path.join(installation, 'extension.js');

		try {
			await project(installation);
			await writeFile(
				extension,
				`
import first from './first/peer.js';
import second from './second/peer.js';
export default (pi) => { first(pi); second(pi); };
`
			);

			const installed = await Promise.all(
				revisions.map(async (revision, index) => {
					const label = index === 0 ? 'first' : 'second';
					const prefix = path.join(installation, label);
					const archive = await archiveDraft(directory, revision);

					await project(prefix);
					await add(prefix, [archive]);
					await Promise.all([
						writeFile(path.join(prefix, 'peer.js'), peerExtension),
						writeFile(
							path.join(prefix, 'peer.json'),
							JSON.stringify({ trace, label, isProvider: index === 0 })
						)
					]);

					return { prefix, label, buildId: await archiveBuildId(archive) };
				})
			);

			await startPi(installation, extension);

			const before = await readTrace(trace);

			expect(before).toStrictEqual(
				installed.map(({ label, buildId }) => ({
					pid: expect.any(Number) as unknown,
					label,
					buildId,
					packageVersion: '0.0.0',
					major: 1,
					featureLevel: 0
				}))
			);

			let release = retainedReleaseArchive(packageName);

			if (release === undefined) {
				await run(sdk, 'pnpm', ['build']);
				release = await pack(sdk, directory);
			}

			for (const { prefix } of installed) {
				await add(prefix, [release]);
			}

			await startPi(installation, extension, 'cutover check');

			const records = await readTrace(trace);
			const after = records.slice(before.length);
			const buildId = await archiveBuildId(release);

			expect({ before: records.slice(0, before.length), after }).toStrictEqual({
				before,
				after: installed.map(({ label }) => ({
					pid: expect.any(Number) as unknown,
					label,
					buildId,
					packageVersion: '1.0.0',
					major: 1,
					featureLevel: 0,
					provider: 'fixture.release-restart'
				}))
			});

			const oldProcess = before[0];
			const newProcess = after[0];

			if (!isRecord(oldProcess) || !isRecord(newProcess)) {
				throw new Error('Pi did not report both startup phases.');
			}

			expect(newProcess['pid']).not.toBe(oldProcess['pid']);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	},
	180_000
);
