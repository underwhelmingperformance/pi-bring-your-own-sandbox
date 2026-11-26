import { isUtf8 } from 'node:buffer';
import { once } from 'node:events';
import { constants } from 'node:fs';
import { access, open, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { GrepMatch } from './contracts.js';

const [operation, encoded, maximum, workspace] = process.argv.slice(1);
const options = new URLSearchParams(encoded);
const root = path.resolve(
	workspace ?? process.cwd(),
	options.get('path') ?? '.'
);
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

async function* walk(
	filename: string,
	relative: string
): AsyncGenerator<Entry> {
	const directory = await open(
		filename,
		constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW
	);

	try {
		const base = '/proc/self/fd/' + String(directory.fd);
		const entries = await readdir(base, {
			withFileTypes: true,
			encoding: 'buffer'
		});
		const sorted = entries.toSorted((left, right) =>
			left.name.compare(right.name)
		);

		for (const entry of sorted) {
			if (!isUtf8(entry.name)) {
				continue;
			}

			const name = entry.name.toString('utf8');

			if (name === '.git' || name === 'node_modules') {
				continue;
			}

			const child = path.join(relative, name);
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
					yield* walk(pinnedChild, child);
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
	// O_PATH pins the explicit root without opening a device. Child lookups use the parent's descriptor.
	await using pinned = await open(root, 0o1000_0000);

	const filename = '/proc/self/fd/' + String(pinned.fd);
	const stat = await pinned.stat();

	if (stat.isDirectory()) {
		yield* walk(filename + '/.', '');

		return;
	}

	if (operation === 'grep' && stat.isFile()) {
		yield {
			relative: path.basename(root),
			filename,
			pinnedRoot: true,
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
			(entry.pinnedRoot === true ? 0 : constants.O_NOFOLLOW)
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
	const { RE2JS } = await import('re2js');

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
		if (entry.kind !== 'file' || !isPathIncluded(entry.relative)) {
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
	if (process.platform !== 'linux' || !(await hasDescriptorPaths())) {
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
