import { constants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

import type { GrepMatch } from 'pi-bring-your-own-sandbox/api';

const [operation, encoded, maximum] = process.argv.slice(1);
const options = new URLSearchParams(encoded);
const root = path.resolve(options.get('path') ?? '.');
const limit = Number(
	options.get('limit') ?? (operation === 'find' ? 1000 : 100)
);
const maxBytes = Number(maximum);
const glob = options.get(operation === 'find' ? 'pattern' : 'glob');

interface Entry {
	readonly relative: string;
	readonly kind: 'directory' | 'file' | 'other';
}

async function* walk(relative: string): AsyncGenerator<Entry> {
	const entries = await readdir(path.join(root, relative), {
		withFileTypes: true
	});

	const ordered = entries.toSorted((left, right) =>
		left.name < right.name ? -1 : Number(left.name > right.name)
	);

	for (const entry of ordered) {
		if (entry.name === '.git' || entry.name === 'node_modules') {
			continue;
		}

		const child = path.join(relative, entry.name);

		yield {
			relative: child,
			kind: entry.isDirectory()
				? 'directory'
				: entry.isFile()
					? 'file'
					: 'other'
		};

		if (entry.isDirectory()) {
			yield* walk(child);
		}
	}
}

async function* candidates(): AsyncGenerator<Entry> {
	const stat = await lstat(root);

	if (stat.isDirectory()) {
		yield* walk('');

		return;
	}

	if (operation === 'grep' && stat.isFile()) {
		yield { relative: path.basename(root), kind: 'file' };

		return;
	}

	throw new TypeError('The search root must be a directory or a regular file.');
}

async function lines(filename: string): Promise<string[]> {
	const file = await open(
		filename,
		constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW
	);

	try {
		const stat = await file.stat();

		if (!stat.isFile()) {
			return [];
		}

		if (stat.size > maxBytes) {
			throw new RangeError('A search input exceeds the file size limit.');
		}

		const chunks: Buffer[] = [];
		let bytes = 0;

		const stream = file.createReadStream({ autoClose: false });

		for await (const chunk of stream) {
			if (!Buffer.isBuffer(chunk)) {
				throw new TypeError('Expected binary file input.');
			}

			bytes += chunk.length;

			if (bytes > maxBytes) {
				throw new RangeError('A search input exceeds the file size limit.');
			}

			if (chunk.includes(0)) {
				return [];
			}

			chunks.push(chunk);
		}

		const text = Buffer.concat(chunks).toString('utf8');

		if (text.length === 0) {
			return [];
		}

		const result = text.split(/\r?\n/u);

		if (text.endsWith('\n')) {
			result.pop();
		}

		return result;
	} finally {
		await file.close();
	}
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

async function* grep(): AsyncGenerator<GrepMatch> {
	const pattern = options.get('pattern') ?? '';
	const isIgnoreCase = options.get('ignoreCase') === 'true';
	const isLiteral = options.get('literal') === 'true';
	const regex = isLiteral
		? undefined
		: new RegExp(pattern, isIgnoreCase ? 'iu' : 'u');
	const needle = isIgnoreCase ? pattern.toLowerCase() : pattern;
	const context = Number(options.get('context') ?? 0);
	const target = await lstat(root);

	for await (const { relative, kind } of candidates()) {
		if (kind !== 'file' || !isPathIncluded(relative)) {
			continue;
		}

		const content = await lines(
			target.isFile() ? root : path.join(root, relative)
		);

		for (const [index, text] of content.entries()) {
			const isFound =
				regex?.test(text) ??
				(isIgnoreCase ? text.toLowerCase() : text).includes(needle);

			if (isFound) {
				yield {
					path: relative,
					line: index + 1,
					text,
					before: content.slice(Math.max(0, index - context), index),
					after: content.slice(index + 1, index + 1 + context)
				};
			}
		}
	}
}

async function collect<Value>(
	source: AsyncIterable<Value>,
	key: 'paths' | 'matches'
) {
	const items: Value[] = [];
	let bytes = 0;
	let isTruncated = false;

	for await (const item of source) {
		if (items.length === limit) {
			isTruncated = true;
			break;
		}

		bytes += Buffer.byteLength(JSON.stringify(item)) + 1;

		if (bytes > maxBytes) {
			throw new RangeError('Search output exceeds the transfer limit.');
		}

		items.push(item);
	}

	const result = JSON.stringify({ [key]: items, truncated: isTruncated });

	if (Buffer.byteLength(result) > maxBytes) {
		throw new RangeError('Search output exceeds the transfer limit.');
	}

	process.stdout.write(result);
}

try {
	if (operation === 'find') {
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
