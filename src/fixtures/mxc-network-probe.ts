import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { link, mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { createConnection, createServer } from 'node:net';
import path from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const launch =
	'const {run}=await import(process.argv[1]);const result=await run(JSON.parse(process.argv[2]),{telemetry:{enabled:false}});console.log(JSON.stringify({exitCode:result.exitCode,stdout:result.stdout,stderr:result.stderr}));';

async function verifyRelay(
	filename: string,
	received: ReadonlySet<string>
): Promise<void> {
	const nonce = randomUUID();
	const connection = createConnection(filename);
	const signal = AbortSignal.timeout(2000);

	try {
		await once(connection, 'connect', { signal });
		connection.write(`${nonce}\n`);
		await once(connection, 'data', { signal });
		assert.equal(received.has(nonce), true);
	} finally {
		connection.destroy();
	}
}

export default async function probe(sdkEntry: string): Promise<void> {
	const temporary = await mkdtemp('/private/tmp/byos-mxc-network-');
	const root = await realpath(temporary);
	const workspace = path.join(root, 'workspace');
	const grant = path.join(root, 'grant');
	const received = new Set<string>();
	const tcp = createServer((socket) => {
		socket.setTimeout(2000, () => socket.destroy());
		socket.on('error', () => socket.destroy());

		let input = '';

		socket.on('data', (data: Buffer) => {
			input += data.toString();

			if (!input.endsWith('\n')) {
				return;
			}

			received.add(input.trimEnd());
			socket.end('observed');
		});
	});

	tcp.listen(0, '127.0.0.1');
	await once(tcp, 'listening', { signal: AbortSignal.timeout(2000) });

	const address = tcp.address();

	if (address === null || typeof address === 'string') {
		throw new Error('The controlled TCP listener has no address.');
	}

	const relay = () =>
		createServer((socket) => {
			const upstream = createConnection(address.port, '127.0.0.1');

			socket.setTimeout(2000, () => socket.destroy());
			upstream.setTimeout(2000, () => upstream.destroy());

			socket.pipe(upstream).pipe(socket);
			upstream.on('error', (error) => socket.destroy(error));
			socket.on('error', () => {
				socket.destroy();
			});
		});
	const local = relay();
	const external = relay();

	try {
		await Promise.all([mkdir(workspace), mkdir(grant)]);
		local.listen(path.join(workspace, 'relay.sock'));
		external.listen(path.join(grant, 'relay.sock'));

		const signal = AbortSignal.timeout(2000);

		await Promise.all([
			once(local, 'listening', { signal }),
			once(external, 'listening', { signal })
		]);
		await symlink(
			path.join(grant, 'relay.sock'),
			path.join(workspace, 'alias.sock')
		);

		await link(
			path.join(grant, 'relay.sock'),
			path.join(workspace, 'hardlink.sock')
		);

		await verifyRelay(path.join(workspace, 'relay.sock'), received);
		console.log(JSON.stringify({ case: 'host-control', observed: true }));
		await verifyRelay(path.join(workspace, 'hardlink.sock'), received);
		console.log(
			JSON.stringify({ case: 'hardlink-host-control', observed: true })
		);

		const cases = [
			{
				label: 'workspace-read-write',
				socket: path.join(workspace, 'relay.sock'),
				writable: [workspace],
				readonly: [],
				expected: true
			},
			{
				label: 'workspace-read-only',
				socket: path.join(workspace, 'relay.sock'),
				writable: [],
				readonly: [workspace],
				expected: false
			},
			{
				label: 'grant-read-write',
				socket: path.join(grant, 'relay.sock'),
				writable: [grant],
				readonly: [workspace],
				expected: true
			},
			{
				label: 'grant-read-only',
				socket: path.join(grant, 'relay.sock'),
				writable: [],
				readonly: [workspace, grant],
				expected: false
			},
			{
				label: 'alias-writable-grant',
				socket: path.join(workspace, 'alias.sock'),
				writable: [grant],
				readonly: [workspace],
				expected: true
			},
			{
				label: 'alias-read-only-grant',
				socket: path.join(workspace, 'alias.sock'),
				writable: [],
				readonly: [workspace, grant],
				expected: false
			},
			{
				label: 'hardlink-writable-workspace',
				socket: path.join(workspace, 'hardlink.sock'),
				writable: [workspace],
				readonly: [grant],
				expected: false
			},
			{
				label: 'hardlink-read-only-workspace',
				socket: path.join(workspace, 'hardlink.sock'),
				writable: [grant],
				readonly: [workspace],
				expected: true
			},
			{
				label: 'hardlink-both-read-only',
				socket: path.join(workspace, 'hardlink.sock'),
				writable: [],
				readonly: [workspace, grant],
				expected: false
			}
		];

		for (const scenario of cases) {
			const nonce = randomUUID();
			const request = {
				containment: { type: 'seatbelt' },
				command:
					'printf "%s\\n" "$BYOS_PROBE_NONCE" | /usr/bin/nc -w 1 -U "$BYOS_PROBE_SOCKET"',
				workingDirectory: workspace,
				timeoutMs: 5000,
				filesystem: {
					readonlyPaths: scenario.readonly,
					readwritePaths: scenario.writable
				},
				network: { egress: { default: 'deny' }, ingress: { default: 'deny' } },
				environment: {
					PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
					BYOS_PROBE_NONCE: nonce,
					BYOS_PROBE_SOCKET: scenario.socket
				},
				inheritDefaultEnvironment: false,
				ui: { disable: true }
			};
			const result = await execute(
				process.execPath,
				[
					'--input-type=module',
					'-e',
					launch,
					sdkEntry,
					JSON.stringify(request)
				],
				{ timeout: 15_000 }
			);
			const native: unknown = JSON.parse(result.stdout);
			const isObserved = received.has(nonce);

			console.log(
				JSON.stringify({
					case: scenario.label,
					observed: isObserved,
					native,
					supervisorStderr: result.stderr
				})
			);
			assert.deepEqual(
				{ observed: isObserved, native, supervisorStderr: result.stderr },
				{
					observed: scenario.expected,
					native: {
						exitCode: scenario.expected ? 0 : 1,
						stdout: '',
						stderr: ''
					},
					supervisorStderr: ''
				},
				scenario.label
			);
		}
	} finally {
		await Promise.all(
			[local, external, tcp].map(
				(server) =>
					new Promise<void>((resolve, reject) =>
						server.close((error) => {
							if (error !== undefined) {
								reject(error);

								return;
							}

							resolve();
						})
					)
			)
		);
		await rm(root, { recursive: true, force: true });
	}
}
