import { mkdir, mkdtemp, realpath, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';

import { resolvePathGrants } from './path-grants.js';

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
