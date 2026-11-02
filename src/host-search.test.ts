import {
	mkdir,
	mkdtemp,
	realpath,
	rm,
	symlink,
	writeFile
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterEach, expect, it, vi } from 'vitest';

import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { openPassthrough } from './passthrough.js';

const releases: (() => Promise<void>)[] = [];

afterEach(async () => {
	for (const release of releases.splice(0).toReversed()) {
		await release();
	}

	vi.unstubAllEnvs();
});

async function fixture(prepare?: (directory: string) => void | Promise<void>) {
	const temporary = await mkdtemp(path.join(tmpdir(), 'pi-byos-search-'));
	const directory = await realpath(temporary);

	releases.push(() => rm(directory, { recursive: true, force: true }));
	vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(directory, 'absent-git-config'));
	vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');
	vi.stubEnv('PI_CODING_AGENT_DIR', path.join(directory, 'agent'));
	await prepare?.(directory);

	const backend = await openPassthrough(directory, {
		reportDiagnostic() {
			return;
		},
		cleanup: { deadline: undefined },
		operationId: 'open',
		signal: new AbortController().signal,
		deadline: Date.now() + 10_000,
		confirmCleanup() {
			return;
		},
		reportRecovery(recovery) {
			expect(recovery).toStrictEqual({ kind: 'none' });
		}
	});

	releases.push(() =>
		backend.dispose({
			reportDiagnostic() {
				return;
			},
			cleanup: { deadline: undefined },
			operationId: 'dispose',
			signal: new AbortController().signal,
			deadline: Date.now() + 10_000
		})
	);

	return { directory, sandbox: createSandbox(new TestBackendOwner(backend)) };
}

async function seed(
	directory: string,
	files: Readonly<Record<string, string | Uint8Array>>
): Promise<void> {
	await Promise.all(
		Object.entries(files).map(async ([filename, content]) => {
			const target = path.join(directory, filename);

			await mkdir(path.dirname(target), { recursive: true });
			await writeFile(target, content);
		})
	);
}

it('finds hidden files, respects ignore files, excludes dependency directories and orders paths as UTF-8', async () => {
	const { directory, sandbox } = await fixture();

	await seed(directory, {
		'.hidden.txt': '',
		'a.txt': '',
		'z.txt': '',
		'upper.TXT': '',
		'\u{E000}.txt': '',
		'😀.txt': '',
		'line\nbreak.txt': '',
		'.git/internal.txt': '',
		'node_modules/pkg/file.txt': '',
		'nested/a.txt': '',
		'.gitignore': 'ignored.txt\n',
		'.ignore': 'ignored-again.txt\n',
		'ignored.txt': '',
		'ignored-again.txt': ''
	});
	await symlink('nested', path.join(directory, 'linked'));
	expect(await sandbox.search.find({ pattern: '*.txt' })).toStrictEqual({
		paths: [
			'.hidden.txt',
			'a.txt',
			'line\nbreak.txt',
			'nested/a.txt',
			'upper.TXT',
			'z.txt',
			'\u{E000}.txt',
			'😀.txt'
		],
		truncated: false
	});
});

it('drains grep output beyond the process capture bound while retaining the ordered result limit and context', async () => {
	const { directory, sandbox } = await fixture();
	const lines = Array.from(
		{ length: 16_000 },
		(_value, index) => `needle ${String(index + 1)}`
	);

	await seed(directory, { 'large.txt': `${lines.join('\n')}\n` });
	expect(
		await sandbox.search.grep({ pattern: 'needle', limit: 2, context: 1 })
	).toStrictEqual({
		matches: [
			{
				path: 'large.txt',
				line: 1,
				text: 'needle 1',
				before: [],
				after: ['needle 2']
			},
			{
				path: 'large.txt',
				line: 2,
				text: 'needle 2',
				before: ['needle 1'],
				after: ['needle 3']
			}
		],
		truncated: true
	});
});

it('returns ordered matching lines with overlapping context and CRLF removed', async () => {
	const { directory, sandbox } = await fixture();

	await seed(directory, {
		'z.txt': 'needle z\n',
		'a.txt': 'before\r\nneedle needle\r\nneedle next\r\nafter\r\n',
		'.hidden.txt': 'needle hidden\n'
	});
	expect(
		await sandbox.search.grep({ pattern: 'needle', context: 1 })
	).toStrictEqual({
		matches: [
			{
				path: '.hidden.txt',
				line: 1,
				text: 'needle hidden',
				before: [],
				after: []
			},
			{
				path: 'a.txt',
				line: 2,
				text: 'needle needle',
				before: ['before'],
				after: ['needle next']
			},
			{
				path: 'a.txt',
				line: 3,
				text: 'needle next',
				before: ['needle needle'],
				after: ['after']
			},
			{ path: 'z.txt', line: 1, text: 'needle z', before: [], after: [] }
		],
		truncated: false
	});
});

it.each([
	{ literal: false, ignoreCase: false, lines: [1, 2] },
	{ literal: true, ignoreCase: false, lines: [1] },
	{ literal: true, ignoreCase: true, lines: [1, 3] }
])(
	'uses ripgrep matching for literal=$literal and ignoreCase=$ignoreCase',
	async ({ literal, ignoreCase, lines }) => {
		const { directory, sandbox } = await fixture();

		await seed(directory, {
			'file.txt': 'a.b\naxb\nA.B\n',
			'other.md': 'a.b\n'
		});

		const result = await sandbox.search.grep({
			pattern: 'a.b',
			glob: '*.txt',
			literal,
			ignoreCase
		});
		const text = ['a.b', 'axb', 'A.B'];

		expect(result).toStrictEqual({
			matches: lines.map((line) => ({
				path: 'file.txt',
				line,
				text: text[line - 1],
				before: [],
				after: []
			})),
			truncated: false
		});
	}
);

it('discards early matches when ripgrep later detects binary content and does not follow directory symlinks', async () => {
	const { directory, sandbox } = await fixture();
	const outside = await mkdtemp(path.join(tmpdir(), 'pi-byos-search-outside-'));

	releases.push(() => rm(outside, { recursive: true, force: true }));
	await seed(outside, { 'external.txt': 'needle outside\n' });
	await symlink(outside, path.join(directory, 'linked'));
	await seed(directory, {
		'a-binary': Buffer.from(`needle\n${'x\n'.repeat(70_000)}\0tail`),
		text: 'needle text\n'
	});
	expect(
		await sandbox.search.grep({ pattern: 'needle', limit: 1 })
	).toStrictEqual({
		matches: [
			{ path: 'text', line: 1, text: 'needle text', before: [], after: [] }
		],
		truncated: false
	});
});

it.each([1, 2, 3])(
	'applies limit %s after ordering and reports only omitted results',
	async (limit) => {
		const { directory, sandbox } = await fixture();

		await seed(directory, { 'z.txt': 'needle z\n', 'a.txt': 'needle a\n' });
		expect({
			find: await sandbox.search.find({ pattern: '*.txt', limit }),
			grep: await sandbox.search.grep({ pattern: 'needle', limit })
		}).toStrictEqual({
			find: { paths: ['a.txt', 'z.txt'].slice(0, limit), truncated: limit < 2 },
			grep: {
				matches: [
					{ path: 'a.txt', line: 1, text: 'needle a', before: [], after: [] },
					{ path: 'z.txt', line: 1, text: 'needle z', before: [], after: [] }
				].slice(0, limit),
				truncated: limit < 2
			}
		});
	}
);

it('resolves explicit file and directory roots and treats a leading bang in a find pattern literally', async () => {
	const { directory, sandbox } = await fixture();

	await seed(directory, {
		'nested/file.txt': 'needle\n',
		'nested/!file.txt': 'needle bang\n',
		'other/file.txt': 'other\n'
	});
	expect({
		find: await sandbox.search.find({ path: 'nested', pattern: '!*.txt' }),
		nestedGlob: await sandbox.search.find({ pattern: 'nested/*.txt' }),
		grep: await sandbox.search.grep({
			path: path.join(directory, 'nested/file.txt'),
			pattern: 'needle'
		})
	}).toStrictEqual({
		find: { paths: ['!file.txt'], truncated: false },
		nestedGlob: {
			paths: ['nested/!file.txt', 'nested/file.txt'],
			truncated: false
		},
		grep: {
			matches: [
				{ path: 'file.txt', line: 1, text: 'needle', before: [], after: [] }
			],
			truncated: false
		}
	});
});

it('returns empty results and preserves backend usability after missing roots and invalid regexes', async () => {
	const { directory, sandbox } = await fixture();

	await seed(directory, { file: 'content\n' });
	expect({
		find: await sandbox.search.find({ pattern: '*.absent' }),
		grep: await sandbox.search.grep({ pattern: 'absent' })
	}).toStrictEqual({
		find: { paths: [], truncated: false },
		grep: { matches: [], truncated: false }
	});
	await expect(
		sandbox.search.find({ path: 'absent', pattern: '*' })
	).rejects.toMatchObject({ name: 'SandboxPathNotFoundError' });
	await expect(sandbox.search.grep({ pattern: '[' })).rejects.toMatchObject({
		name: 'SandboxOperationError'
	});
	await expect(sandbox.search.find({ pattern: '[' })).rejects.toMatchObject({
		name: 'SandboxOperationError'
	});
	expect(new TextDecoder().decode(await sandbox.files.readFile('file'))).toBe(
		'content\n'
	);
});

it('honours ignore files outside a repository and preserves nested repository boundaries', async () => {
	const { directory, sandbox } = await fixture();

	await seed(directory, {
		'.gitignore': 'ignored.txt\n',
		'.ignore': 'ignored-again.txt\n',
		'ignored.txt': 'needle ignored\n',
		'ignored-again.txt': 'needle ignored again\n',
		'kept.txt': 'needle kept\n'
	});
	expect(await sandbox.search.grep({ pattern: 'needle' })).toStrictEqual({
		matches: [
			{ path: 'kept.txt', line: 1, text: 'needle kept', before: [], after: [] }
		],
		truncated: false
	});
	await seed(directory, {
		'.git/HEAD': 'ref: refs/heads/main\n',
		'.gitignore': '**/skip.txt\n',
		'skip.txt': 'needle root\n',
		'nested/.git/HEAD': 'ref: refs/heads/main\n',
		'nested/skip.txt': 'needle nested\n'
	});
	expect({
		find: await sandbox.search.find({ pattern: 'skip.txt' }),
		grep: await sandbox.search.grep({ pattern: 'needle (root|nested)' })
	}).toStrictEqual({
		find: { paths: ['nested/skip.txt'], truncated: false },
		grep: {
			matches: [
				{
					path: 'nested/skip.txt',
					line: 1,
					text: 'needle nested',
					before: [],
					after: []
				}
			],
			truncated: false
		}
	});
});

it('ignores ambient ripgrep flags and decodes base64 line data without changing search semantics', async () => {
	const { sandbox } = await fixture(async (directory) => {
		await seed(directory, {
			'rg-options': '--ignore-case\n',
			'file.txt': Buffer.from([
				110, 101, 101, 100, 108, 101, 32, 255, 10, 78, 69, 69, 68, 76, 69, 10
			])
		});
		vi.stubEnv('RIPGREP_CONFIG_PATH', path.join(directory, 'rg-options'));
	});

	expect(await sandbox.search.grep({ pattern: 'needle' })).toStrictEqual({
		matches: [
			{ path: 'file.txt', line: 1, text: 'needle �', before: [], after: [] }
		],
		truncated: false
	});
});

it('omits search capabilities when ripgrep is unavailable and never downloads a tool', async () => {
	const { sandbox } = await fixture((directory) => {
		vi.stubEnv('PATH', directory);
	});

	expect(sandbox.capabilities).toStrictEqual({
		processKinds: ['argv'],
		terminationScope: 'process-group',
		exitStatus: 'guaranteed',
		operations: ['exec', 'files.read', 'files.write', 'files.list'],
		shells: []
	});
	await expect(sandbox.search.find({ pattern: '*' })).rejects.toMatchObject({
		name: 'UnsupportedSandboxCapabilityError'
	});
});

it('preserves directory markers from fd', async () => {
	const { directory, sandbox } = await fixture();

	await seed(directory, { 'folder/file.txt': '' });
	expect(await sandbox.search.find({ pattern: '*' })).toStrictEqual({
		paths: ['folder/', 'folder/file.txt'],
		truncated: false
	});
});
