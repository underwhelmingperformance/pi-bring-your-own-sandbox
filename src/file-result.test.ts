import { expect, it } from 'vitest';

import {
	isDirectoryEntries,
	isFileStat,
	isFindResult,
	isGrepResult
} from './file-result.js';

it.each([
	{ paths: ['../escape'], truncated: false },
	{ paths: ['/absolute'], truncated: false },
	{ paths: ['same', 'same'], truncated: false },
	{ paths: ['same', 'same/'], truncated: false },
	{ paths: ['double//'], truncated: false },
	{ paths: ['a'], truncated: true },
	{ paths: [], truncated: true }
])('rejects invalid or incomplete find results: %j', (result) => {
	expect(isFindResult(result, 'posix', 2)).toBe(false);
});

it('accepts provider ordering and recognises duplicate Windows paths', () => {
	expect([
		isFindResult({ paths: ['ä', 'a', 'Z'], truncated: false }, 'posix', 3),
		isFindResult({ paths: ['a\\file', 'b/file'], truncated: true }, 'win32', 2),
		isFindResult(
			{ paths: ['a\\file', 'a/file'], truncated: false },
			'win32',
			2
		),
		isFindResult({ paths: ['C:relative'], truncated: false }, 'win32', 1)
	]).toStrictEqual([true, true, false, false]);
});

it.each([
	{ path: 'file', line: 0, text: 'match', before: [], after: [] },
	{
		path: 'file',
		line: 1,
		text: 'match',
		before: ['impossible preceding line'],
		after: []
	},
	{ path: 'file', line: 2, text: 'match\n', before: [], after: [] },
	{ path: '../escape', line: 1, text: 'match', before: [], after: [] }
])('rejects invalid grep matches: %j', (match) => {
	expect(
		isGrepResult({ matches: [match], truncated: false }, 'posix', 2, 1)
	).toBe(false);
});

it('accepts provider match order and checks limits and context', () => {
	const first = {
		path: 'file',
		line: 2,
		text: 'first',
		before: ['before'],
		after: ['after']
	};
	const second = {
		path: 'file',
		line: 10,
		text: 'second',
		before: [],
		after: []
	};
	expect([
		isGrepResult({ matches: [first, second], truncated: false }, 'posix', 2, 1),
		isGrepResult({ matches: [second, first], truncated: false }, 'posix', 2, 1),
		isGrepResult({ matches: [first, first], truncated: false }, 'posix', 2, 1),
		isGrepResult({ matches: [first], truncated: true }, 'posix', 2, 1),
		isGrepResult({ matches: [first], truncated: false }, 'posix', 2, 0)
	]).toStrictEqual([true, true, false, false, false]);
});

it('follows stat target kinds but preserves symlink directory entries', () => {
	expect([
		isFileStat({ kind: 'symlink', size: 1 }),
		isFileStat({ kind: 'file', size: -1 }),
		isFileStat({ kind: 'file', size: 1 }),
		isDirectoryEntries([{ name: 'link', kind: 'symlink' }], 'posix'),
		isDirectoryEntries([{ name: 'parent/child', kind: 'file' }], 'posix'),
		isDirectoryEntries(
			[
				{ name: 'same', kind: 'file' },
				{ name: 'same', kind: 'directory' }
			],
			'posix'
		)
	]).toStrictEqual([false, false, true, true, false, false]);
});

it.each([
	{ flavor: 'posix' as const, paths: ['dir/', 'dir/file'] },
	{ flavor: 'win32' as const, paths: ['dir\\', 'dir\\file'] }
])(
	'accepts target-native directory markers for $flavor',
	({ flavor, paths }) => {
		expect(isFindResult({ paths, truncated: false }, flavor, 2)).toBe(true);
	}
);
