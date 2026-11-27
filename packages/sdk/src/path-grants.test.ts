import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { homedir, platform, tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { hostSystemRoots } from './host-system-roots.js';
import { resolvePathGrants } from './path-grants.js';
import { defaultPolicy } from './policy-model.js';
import { selectProfile } from './profile-negotiation.js';

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
			'/System/Applications/byos',
			'/System/Cryptexes/byos',
			'/System/Developer/byos',
			'/System/DriverKit/byos',
			'/System/KernelKit/byos',
			'/System/Library/byos',
			'/System/iOSSupport/byos',
			'/System/x86Support/byos',
			'/Library/Apple/System/byos',
			'/Library/Developer/CommandLineTools/byos',
			'/Applications/Xcode.app/Contents/Developer/byos'
		],
		user: [
			'/etc/distinct/byos',
			'/System/byos',
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
		const nixos = '/nix/store/byos-nixos-system';
		const currentSystem = '/run/current-system';
		const aliases = new Map([
			[path.resolve('/etc/byos'), path.resolve(etc)],
			[path.resolve('/usr/bin/alias'), path.resolve('/var/byos')],
			[credential, relocated],
			[path.join(credential, 'key'), path.join(relocated, 'key')]
		]);

		if (host === 'linux') {
			aliases.set(path.resolve(currentSystem), path.resolve(nixos));
		}

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
				'/nix/store/byos-shell/bin/sh',
				'/nix/var/nix/profiles/byos',
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
					host === 'linux' ? currentSystem : nixos,
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
					...[etc, nixos, ...systemPaths].map((name) => ({
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
			expect(hostSystemRoots[host].includes(currentSystem)).toBe(
				host === 'linux'
			);
		} finally {
			vi.mocked(platform).mockReset();
			vi.mocked(realpath).mockReset();
			vi.mocked(homedir).mockReset();
		}
	}
);

it.skipIf(path.sep !== '/')(
	'classifies macOS Data volume aliases before checking ordinary grants',
	async () => {
		const home = '/Users/byos-fixture';
		const checkout = path.join(home, 'checkout');
		const dataHome = '/System/Volumes/Data' + home;
		const ordinary = path.join(dataHome, 'notes');
		const credential = path.join(dataHome, '.ssh', 'marker');
		const linkedCredential = path.join(dataHome, '.ssh', 'linked');
		const credentialTarget = '/private/var/byos-credential';
		const checkoutFile = path.join(dataHome, 'checkout', 'file');
		const library = '/System/Library/byos';
		const cryptex = '/System/Cryptexes/OS/byos';
		const preboot = '/System/Volumes/Preboot/Cryptexes/OS/byos';
		const otherPreboot = '/System/Volumes/Preboot/byos';
		const aliases = new Map([
			[linkedCredential, credentialTarget],
			[cryptex, preboot]
		]);
		const profile = {
			policy: defaultPolicy,
			capabilities: ['exec'],
			processKinds: ['argv'],
			shells: [],
			exitStatus: 'guaranteed',
			terminationScope: 'workload'
		} as const;

		vi.mocked(homedir).mockReturnValue(home);
		vi.mocked(platform).mockReturnValue('darwin');
		vi.mocked(realpath).mockImplementation((filename) => {
			const absolute = String(filename);

			return Promise.resolve(aliases.get(absolute) ?? absolute);
		});

		try {
			const paths = await resolvePathGrants(checkout, {
				read: [
					ordinary,
					credential,
					linkedCredential,
					checkoutFile,
					library,
					cryptex,
					otherPreboot
				]
			});
			const selection = selectProfile({
				profiles: [profile],
				limit: profile.policy,
				paths: paths.filter((entry) => entry.path === credential)
			});

			expect({ paths, selection }).toStrictEqual({
				paths: [
					{ kind: 'read', path: library, location: 'host-system-files' },
					{
						kind: 'read',
						path: credential,
						location: 'host-user-data',
						isCredential: true
					},
					{ kind: 'read', path: checkoutFile, location: 'workspace' },
					{ kind: 'read', path: ordinary, location: 'host-user-data' },
					{ kind: 'read', path: preboot, location: 'host-system-files' },
					{ kind: 'read', path: otherPreboot, location: 'host-user-data' },
					{
						kind: 'read',
						path: credentialTarget,
						location: 'host-user-data',
						isCredential: true
					}
				],
				selection: {
					ok: false,
					detail: {
						kind: 'path',
						access: 'read',
						path: credential,
						reason: 'limit'
					}
				}
			});
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

it.skipIf(path.sep !== '/')(
	'treats package credentials and both Pi stores as credential paths',
	async () => {
		const directory = await mkdtemp(
			path.join(tmpdir(), 'byos-credential-roots-')
		);

		try {
			const root = await realpath(directory);
			const checkout = path.join(root, 'checkout');
			const home = path.join(root, 'home');
			const agent = path.join(root, 'custom-agent');
			const alias = path.join(root, 'auth-alias');
			const auth = path.join(agent, 'auth.json');
			const oauth = path.join(agent, 'mcp-auth.json');
			const ordinary = path.join(agent, 'models.json');
			const credentials = [
				'~/.cargo/credentials',
				'~/.cargo/credentials.toml',
				'~/.gem/credentials',
				'~/.npmrc',
				'~/.terraform.d/credentials.tfrc.json',
				'~/.yarnrc.yml'
			];
			const paths = [
				auth,
				oauth,
				...credentials.map((entry) => path.join(home, entry.slice(2)))
			];

			vi.stubEnv('HOME', home);
			vi.stubEnv('PI_CODING_AGENT_DIR', agent);
			await Promise.all([mkdir(checkout), mkdir(home), mkdir(agent)]);
			await writeFile(auth, 'fixture');
			await symlink(auth, alias);

			const result = await resolvePathGrants(checkout, {
				read: [alias, oauth, ordinary, ...credentials]
			});
			const expected = [
				{ kind: 'read', path: ordinary, location: 'host-user-data' },
				...paths.map((credential) => ({
					kind: 'read',
					path: credential,
					location: 'host-user-data',
					isCredential: true
				}))
			].toSorted((a, b) => Number(a.path > b.path) - Number(a.path < b.path));

			expect(result).toStrictEqual(expected);
		} finally {
			vi.unstubAllEnvs();
			await rm(directory, { recursive: true, force: true });
		}
	}
);
