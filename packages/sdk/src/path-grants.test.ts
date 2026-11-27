import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { resolvePathGrants } from './path-grants.js';

vi.mock('node:fs/promises', { spy: true });
vi.mock('node:os', { spy: true });

it.each([
	{
		host: 'linux',
		system: ['/usr/lib64/byos', '/lib/byos', '/lib64/byos'],
		user: [
			'/private/etc/byos',
			'/System/byos',
			'/Library/Apple/System/byos',
			'/Library/Developer/CommandLineTools/byos',
			'/Applications/Xcode.app/Contents/Developer/byos'
		],
		etc: '/etc/byos'
	},
	{
		host: 'darwin',
		system: [
			'/System/byos',
			'/Library/Apple/System/byos',
			'/Library/Developer/CommandLineTools/byos',
			'/Applications/Xcode.app/Contents/Developer/byos'
		],
		user: [
			'/etc/distinct/byos',
			'/lib/byos',
			'/lib64/byos',
			'/usr/lib64/byos',
			'/Applications/Xcode.app/Contents/Info.plist'
		],
		etc: '/private/etc/byos'
	}
] as const)(
	'classifies grants by canonical paths on $host',
	async ({ host, system, user, etc }) => {
		const workspace = path.resolve('/checkout');
		const home = path.resolve('/home/byos-fixture');
		const credential = path.join(home, '.ssh');
		const relocated = path.resolve('/usr/share/byos-credential');
		const aliases = new Map([
			[path.resolve('/etc/byos'), path.resolve(etc)],
			[path.resolve('/usr/bin/alias'), path.resolve('/var/byos')],
			[credential, relocated],
			[path.join(credential, 'key'), path.join(relocated, 'key')]
		]);

		vi.mocked(homedir).mockReturnValue(home);
		vi.mocked(platform).mockReturnValue(host);
		vi.mocked(realpath).mockImplementation((filename) => {
			const absolute = String(filename);

			return Promise.resolve(aliases.get(absolute) ?? absolute);
		});

		try {
			const systemPaths = [
				'/bin/byos',
				'/sbin/byos',
				'/usr/bin/byos',
				'/usr/sbin/byos',
				'/usr/lib/byos',
				'/usr/libexec/byos',
				'/usr/share/byos',
				'/usr/include/byos',
				...system
			];
			const userPaths = [
				'/usr/local/byos',
				'/var/byos',
				'/usr/bin-extra/byos',
				...user
			];
			const paths = await resolvePathGrants(workspace, {
				read: [
					'file',
					'/etc/byos',
					'/usr/bin/alias',
					'~/.ssh/key',
					...systemPaths,
					...userPaths
				]
			});

			expect(paths).toStrictEqual(
				[
					{
						kind: 'read',
						path: path.join(workspace, 'file'),
						location: 'workspace'
					},
					{
						kind: 'read',
						path: path.join(relocated, 'key'),
						location: 'host-system-files',
						isCredential: true
					},
					...[etc, ...systemPaths].map((name) => ({
						kind: 'read',
						path: path.resolve(name),
						location: 'host-system-files'
					})),
					...userPaths.map((name) => ({
						kind: 'read',
						path: path.resolve(name),
						location: 'host-user-data'
					}))
				].toSorted(
					(left, right) =>
						Number(left.path > right.path) - Number(left.path < right.path)
				)
			);
		} finally {
			vi.mocked(platform).mockReset();
			vi.mocked(realpath).mockReset();
			vi.mocked(homedir).mockReset();
		}
	}
);

it('classifies resolved credential paths without changing the checkout boundary', async () => {
	const temporary = await mkdtemp(
		path.join(tmpdir(), 'byos-credential-paths-')
	);

	try {
		const root = await realpath(temporary);
		const home = path.join(root, 'home');
		const checkout = path.join(home, 'project');
		const relocated = path.join(root, 'elsewhere');

		vi.stubEnv('HOME', home);
		await Promise.all([
			mkdir(path.join(checkout, '.ssh'), { recursive: true }),
			mkdir(relocated)
		]);
		await symlink(relocated, path.join(home, '.ssh'));

		expect(
			await resolvePathGrants(checkout, {
				read: [
					'~/.ssh/key',
					path.join(relocated, 'key'),
					'.ssh/key',
					'~/.ssh-extra/key'
				]
			})
		).toStrictEqual([
			{
				kind: 'read',
				path: path.join(relocated, 'key'),
				location: 'host-user-data',
				isCredential: true
			},
			{
				kind: 'read',
				path: path.join(home, '.ssh-extra/key'),
				location: 'host-user-data'
			},
			{
				kind: 'read',
				path: path.join(checkout, '.ssh/key'),
				location: 'workspace'
			}
		]);
	} finally {
		vi.unstubAllEnvs();
		await rm(temporary, { recursive: true, force: true });
	}
});
