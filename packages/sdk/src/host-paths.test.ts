import {
	lstat,
	mkdtemp,
	readlink,
	realpath,
	rm,
	symlink
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { canonicalHostPath } from './host-paths.js';

vi.mock('node:fs/promises', { spy: true });

afterEach(() => {
	vi.resetAllMocks();
});

const absolute = path.resolve('/byos-fixture');
const missing = Object.assign(new Error('Missing path.'), { code: 'ENOENT' });

it.each(['realpath', 'lstat'] as const)(
	'propagates a permission failure from %s',
	async (operation) => {
		const denied = Object.assign(new Error('Access denied.'), {
			code: 'EACCES'
		});

		vi.mocked(realpath).mockRejectedValue(
			operation === 'realpath' ? denied : missing
		);
		vi.mocked(lstat).mockRejectedValue(denied);

		await expect(canonicalHostPath(absolute)).rejects.toBe(denied);

		expect({
			realpath: vi.mocked(realpath).mock.calls,
			lstat: vi.mocked(lstat).mock.calls,
			readlink: vi.mocked(readlink).mock.calls
		}).toStrictEqual({
			realpath: [[absolute]],
			lstat: operation === 'realpath' ? [] : [[absolute]],
			readlink: []
		});
	}
);

it.skipIf(path.sep !== '/')(
	'rejects a link loop encountered during the fallback traversal',
	async () => {
		const temporary = await mkdtemp(path.join(tmpdir(), 'byos-loop-'));
		const link = path.join(temporary, 'link');

		try {
			await symlink(link, link);
			vi.mocked(realpath).mockRejectedValue(missing);

			await expect(canonicalHostPath(link)).rejects.toThrow(RangeError);
		} finally {
			await rm(temporary, { recursive: true, force: true });
		}
	}
);
