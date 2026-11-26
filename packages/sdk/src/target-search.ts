import { isUtf8 } from 'node:buffer';
import { once } from 'node:events';
import { constants } from 'node:fs';
import {
	access,
	type FileHandle,
	lstat,
	open,
	readdir,
	readlink,
	realpath
} from 'node:fs/promises';
import path from 'node:path';

import type ignore from 'ignore';

import type { GrepMatch } from './contracts.js';

declare const createIgnore: typeof ignore;
declare const hasCommandConfinement: boolean;
declare const loadEmbeddedMatcher:
	(() => Promise<typeof import('re2js')>) | undefined;

const isDarwinReader = process.platform === 'darwin' && hasCommandConfinement;
const nativeNoFollowAny: unknown = Reflect.get(constants, 'O_NOFOLLOW_ANY');
const darwinNoFollowAny =
	typeof nativeNoFollowAny === 'number' ? nativeNoFollowAny : 0x20_00_00_00;
const noFollow = isDarwinReader ? darwinNoFollowAny : constants.O_NOFOLLOW;
const [operation, encoded, maximum, workspace] = process.argv.slice(1);
const options = new URLSearchParams(encoded);
const workspaceRoot = await realpath(workspace ?? process.cwd());
const root = path.resolve(workspaceRoot, options.get('path') ?? '.');
const limit = Number(
	options.get('limit') ?? (operation === 'find' ? 1000 : 100)
);
const maxBytes = Number(maximum);
const glob = options.get(operation === 'find' ? 'pattern' : 'glob');

interface Entry {
	readonly relative: string;
	readonly filename: string;
	readonly pinnedRoot?: true;
	readonly kind: 'directory' | 'file' | 'other';
}

function wasRemoved(error: unknown): boolean {
	return (
		error instanceof Error &&
		'code' in error &&
		typeof error.code === 'string' &&
		['ENOENT', 'ENOTDIR', 'ELOOP'].includes(error.code)
	);
}

function directoryPath(directory: FileHandle, filename: string): string {
	return isDarwinReader ? filename : '/proc/self/fd/' + String(directory.fd);
}

async function directoryEntries(directory: FileHandle, filename: string) {
	const options = { withFileTypes: true, encoding: 'buffer' } as const;

	if (!isDarwinReader) {
		return readdir(filename, options);
	}

	const expected = await directory.stat({ bigint: true });

	// Check the inode after chdir because a rename can redirect the path lookup.
	process.chdir(filename);

	const actual = await lstat('.', { bigint: true });

	return actual.dev === expected.dev && actual.ino === expected.ino
		? readdir('.', options)
		: [];
}

async function* walk(
	filename: string,
	relative: string,
	parent?: IgnoreStack
): AsyncGenerator<Entry> {
	const directory = await open(
		filename,
		constants.O_RDONLY | constants.O_DIRECTORY | noFollow
	);

	try {
		const base = directoryPath(directory, filename);
		const ignored =
			parent === undefined
				? undefined
				: await ignoreAt(base, path.join(root, relative), parent);
		const entries = await directoryEntries(directory, base);
		const sorted = entries.toSorted((left, right) =>
			left.name.compare(right.name)
		);

		for (const entry of sorted) {
			if (!isUtf8(entry.name)) {
				continue;
			}

			const name = entry.name.toString('utf8');

			const child = path.join(relative, name);

			if (ignored === undefined) {
				if (name === '.git' || name === 'node_modules') {
					continue;
				}
			} else if (
				!isGrepEntryIncluded(child, entry.isDirectory(), ignored.rules)
			) {
				continue;
			}

			const pinnedChild = path.join(base, name);

			yield {
				relative: child,
				filename: pinnedChild,
				kind: entry.isDirectory()
					? 'directory'
					: entry.isFile()
						? 'file'
						: 'other'
			};

			if (entry.isDirectory()) {
				try {
					yield* walk(pinnedChild, child, ignored);
				} catch (error) {
					if (!wasRemoved(error)) {
						throw error;
					}
				}
			}
		}
	} finally {
		await directory.close();
	}
}

async function* candidates(): AsyncGenerator<Entry> {
	// O_PATH pins the explicit root without opening a device.
	await using pinned = isDarwinReader
		? undefined
		: await open(root, 0o1000_0000);

	const filename = pinned === undefined ? root : directoryPath(pinned, root);
	const stat = pinned === undefined ? await lstat(root) : await pinned.stat();

	if (stat.isDirectory()) {
		const parent = operation === 'grep' ? await inheritedIgnores() : undefined;

		yield* walk(pinned === undefined ? filename : filename + '/.', '', parent);

		return;
	}

	if (operation === 'grep' && stat.isFile()) {
		yield {
			relative: path.basename(root),
			filename,
			...(pinned !== undefined && { pinnedRoot: true }),
			kind: 'file'
		};

		return;
	}

	throw new TypeError('The search root must be a directory or regular file.');
}

async function contents(entry: Entry): Promise<string> {
	const file = await open(
		entry.filename,
		constants.O_RDONLY |
			constants.O_NONBLOCK |
			(entry.pinnedRoot === true ? 0 : noFollow)
	);

	try {
		const stat = await file.stat();

		if (!stat.isFile() || stat.size > maxBytes) {
			return '';
		}

		const chunks: Buffer[] = [];
		let bytes = 0;
		const stream = file.createReadStream({ autoClose: false });

		for await (const chunk of stream) {
			if (!Buffer.isBuffer(chunk)) {
				throw new TypeError('Expected a binary input file.');
			}

			bytes += chunk.length;

			if (chunk.includes(0) || bytes > maxBytes) {
				return '';
			}

			chunks.push(chunk);
		}

		return Buffer.concat(chunks).toString('utf8');
	} finally {
		await file.close();
	}
}

type IgnoreKind = 0 | 1 | 2 | 3;
interface IgnoreRule {
	readonly directory: string;
	readonly priority: IgnoreKind;
	readonly matcher: ReturnType<typeof createIgnore>;
}
interface IgnoreStack {
	readonly inRepository: boolean;
	readonly rules: readonly IgnoreRule[];
}

const ignoreNames = [
	{ filename: '.rgignore', priority: 0 },
	{ filename: '.ignore', priority: 1 },
	{ filename: '.gitignore', priority: 2 }
] as const;

async function readIgnore(
	filename: string,
	directory: string,
	priority: IgnoreKind
): Promise<IgnoreRule | undefined> {
	try {
		const text = await contents({ filename, relative: '', kind: 'file' });

		if (text.length > 0) {
			return {
				directory,
				priority,
				matcher: createIgnore({ ignorecase: false }).add(text)
			};
		}
	} catch (error) {
		if (!wasRemoved(error)) {
			throw error;
		}
	}

	return undefined;
}

async function isRepositoryRoot(descriptor: string): Promise<boolean> {
	try {
		const filename = path.join(descriptor, '.git');
		const metadata = await lstat(filename);

		if (isDarwinReader && (metadata.isDirectory() || metadata.isFile())) {
			await using entry = await open(
				filename,
				constants.O_RDONLY | constants.O_NONBLOCK | noFollow
			);

			const stat = await entry.stat();

			return stat.isDirectory() || stat.isFile();
		}

		return metadata.isDirectory() || metadata.isFile();
	} catch (error) {
		if (!wasRemoved(error)) {
			throw error;
		}

		return false;
	}
}

function isInWorkspace(directory: string): boolean {
	const relative = path.relative(workspaceRoot, directory);

	return relative !== '..' && !relative.startsWith('../');
}

async function repositoryExclude(descriptor: string, directory: string) {
	if (isDarwinReader) {
		return readIgnore(path.join(descriptor, '.git/info/exclude'), directory, 3);
	}

	try {
		await using git = await open(
			path.join(descriptor, '.git'),
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
		);
		await using info = await open(
			'/proc/self/fd/' + String(git.fd) + '/info',
			constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
		);

		return await readIgnore(
			'/proc/self/fd/' + String(info.fd) + '/exclude',
			directory,
			3
		);
	} catch (error) {
		if (!wasRemoved(error)) {
			throw error;
		}

		return;
	}
}

async function ignoreAt(
	descriptor: string,
	directory: string,
	parent: IgnoreStack
): Promise<IgnoreStack> {
	const location = isDarwinReader ? descriptor : await readlink(descriptor);
	const isWorkspaceDirectory = isInWorkspace(location);
	const isGitRoot =
		isWorkspaceDirectory && (await isRepositoryRoot(descriptor));
	const isInRepository =
		isWorkspaceDirectory && (isGitRoot || parent.inRepository);
	const local: IgnoreRule[] = [];

	for (const { filename, priority } of ignoreNames) {
		if (priority === 2 && !isInRepository) {
			continue;
		}

		const rule = await readIgnore(
			path.join(descriptor, filename),
			directory,
			priority
		);

		if (rule !== undefined) {
			local.push(rule);
		}
	}

	if (isGitRoot) {
		const excluded = await repositoryExclude(descriptor, directory);

		if (excluded !== undefined) {
			local.push(excluded);
		}
	}

	const inherited =
		isGitRoot || !isInRepository
			? parent.rules.filter((rule) => rule.priority < 2)
			: parent.rules;

	return {
		inRepository: isInRepository,
		rules: [...local, ...inherited].toSorted(
			(left, right) => left.priority - right.priority
		)
	};
}

async function inheritedIgnores(): Promise<IgnoreStack> {
	const ancestors: string[] = [];
	let current = path.dirname(root);

	while (current !== root && isInWorkspace(current)) {
		ancestors.unshift(current);

		const parent = path.dirname(current);

		if (parent === current) {
			break;
		}

		current = parent;
	}

	let ignored: IgnoreStack = { inRepository: false, rules: [] };

	for (const ancestor of ancestors) {
		await using fd = await open(
			ancestor,
			constants.O_RDONLY |
				constants.O_DIRECTORY |
				(isDarwinReader ? noFollow : 0)
		);

		const descriptor = directoryPath(fd, ancestor);

		ignored = await ignoreAt(descriptor, ancestor, ignored);
	}

	return {
		...ignored,
		rules: ignored.rules.filter(
			(rule) => !rule.matcher.ignores(path.relative(rule.directory, root) + '/')
		)
	};
}

function globOverride(relative: string): boolean | undefined {
	if (glob === null) {
		return undefined;
	}

	const isNegative = glob.startsWith('!');
	const pattern = (isNegative ? glob.slice(1) : glob).replace(/^\//u, '');
	const filename = glob.includes('/') ? relative : path.basename(relative);

	return path.matchesGlob(filename, pattern) ? !isNegative : undefined;
}

function isGrepEntryIncluded(
	relative: string,
	isDirectory: boolean,
	rules: readonly IgnoreRule[]
): boolean {
	const override = globOverride(relative);

	if (override !== undefined) {
		return override;
	}

	if (!isDirectory && glob !== null && !glob.startsWith('!')) {
		return false;
	}

	const filename = path.join(root, relative);

	for (const rule of rules) {
		const candidate =
			path.relative(rule.directory, filename) + (isDirectory ? '/' : '');
		const match = rule.matcher.test(candidate);

		if (match.ignored || match.unignored) {
			return !match.ignored;
		}
	}

	return true;
}

function* textLines(input: string, start = 0) {
	let offset = start;

	while (offset < input.length) {
		const newline = input.indexOf('\n', offset);
		const end = newline === -1 ? input.length : newline;
		const next = end + 1;

		yield {
			start: offset,
			next,
			text: input.slice(
				offset,
				newline !== -1 && end > offset && input[end - 1] === '\r'
					? end - 1
					: end
			)
		};
		offset = next;
	}
}

function adjacent(
	input: string,
	position: number,
	count: number,
	direction: 'before' | 'after'
): string[] {
	const lines: string[] = [];

	if (count === 0) {
		return lines;
	}

	let offset = position;

	if (direction === 'before') {
		for (let index = 0; index < count && offset > 0; index++) {
			const previous = offset <= 1 ? -1 : input.lastIndexOf('\n', offset - 2);

			offset = previous + 1;

			if (index >= 65_536) {
				throw new RangeError('Context exceeds the response limit.');
			}
		}
	}

	for (const line of textLines(input, offset)) {
		if (
			lines.length >= count ||
			(direction === 'before' && line.start >= position)
		) {
			break;
		}

		if (lines.length >= 65_536) {
			throw new RangeError('Context exceeds the response limit.');
		}

		lines.push(line.text);
	}

	return lines;
}

function isPathIncluded(relative: string): boolean {
	return (
		glob === null ||
		path.matchesGlob(
			glob.includes('/') ? relative : path.basename(relative),
			glob
		)
	);
}

async function* find(): AsyncGenerator<string> {
	for await (const { relative, kind } of candidates()) {
		if (isPathIncluded(relative)) {
			yield kind === 'directory' ? relative + '/' : relative;
		}
	}
}

async function compilePattern(pattern: string, isIgnoreCase: boolean) {
	const { RE2JS } = await (loadEmbeddedMatcher?.() ?? import('re2js'));

	return RE2JS.compile(pattern, isIgnoreCase ? RE2JS.CASE_INSENSITIVE : 0);
}

async function* grep(): AsyncGenerator<() => GrepMatch> {
	const pattern = options.get('pattern') ?? '';
	const isIgnoreCase = options.get('ignoreCase') === 'true';
	const isLiteral = options.get('literal') === 'true';
	const regex = isLiteral
		? undefined
		: await compilePattern(pattern, isIgnoreCase);
	const needle = isIgnoreCase ? pattern.toLowerCase() : pattern;
	const context = Number(options.get('context') ?? 0);

	for await (const entry of candidates()) {
		if (entry.kind !== 'file') {
			continue;
		}

		let content: string;

		try {
			content = await contents(entry);
		} catch (error) {
			if (wasRemoved(error)) {
				continue;
			}

			throw error;
		}

		let number = 0;

		for (const line of textLines(content)) {
			number++;

			const isMatches =
				regex?.test(line.text) ??
				(isIgnoreCase ? line.text.toLowerCase() : line.text).includes(needle);

			if (!isMatches) {
				continue;
			}

			const lineNumber = number;

			yield () => ({
				path: entry.relative,
				line: lineNumber,
				text: line.text,
				before: adjacent(content, line.start, context, 'before'),
				after: adjacent(content, line.next, context, 'after')
			});
		}
	}
}

async function collect(
	source: AsyncIterable<string | (() => GrepMatch)>,
	key: 'paths' | 'matches'
) {
	let count = 0;
	let bytes = 0;
	let isTruncated = false;

	async function output(text: string) {
		bytes += Buffer.byteLength(text);

		if (bytes > maxBytes) {
			throw new RangeError('Search output exceeds the transfer limit.');
		}

		if (!process.stdout.write(text)) {
			await once(process.stdout, 'drain');
		}
	}

	await output('{"' + key + '":[');

	for await (const item of source) {
		if (count === limit) {
			isTruncated = true;
			break;
		}

		await output(
			(count === 0 ? '' : ',') +
				JSON.stringify(typeof item === 'string' ? item : item())
		);
		count++;
	}

	await output('],"truncated":' + String(isTruncated) + '}');
}

async function hasDescriptorPaths(): Promise<boolean> {
	try {
		await access('/proc/self/fd');

		return true;
	} catch {
		return false;
	}
}

try {
	if (
		!isDarwinReader &&
		(process.platform !== 'linux' || !(await hasDescriptorPaths()))
	) {
		process.exitCode = 43;
	} else if (operation === 'find') {
		await collect(find(), 'paths');
	} else {
		await collect(grep(), 'matches');
	}
} catch (error) {
	const code =
		error instanceof Error && 'code' in error ? error.code : undefined;

	process.exitCode =
		code === 'ENOENT' || code === 'ENOTDIR'
			? 40
			: code === 'EPERM' || code === 'EACCES'
				? 41
				: 42;
}
