import type { GrepMatch, GrepResult } from './contracts.js';
import { SandboxOperationError } from './errors.js';
import { OrderedResults } from './ordered-results.js';
import type { SearchOutput } from './search-output.js';
import { DelimitedOutput } from './search-output.js';
import { isRecord } from './validation.js';

interface FileLines {
	readonly path: string;
	readonly lines: Map<number, string>;
	readonly matches: Set<number>;
	lastLine: number;
	lastMatch: number;
}

function invalidOutput(): SandboxOperationError {
	return new SandboxOperationError({
		operation: 'grep',
		providerId: 'passthrough'
	});
}

function decode(value: unknown, isPath = false): string {
	if (!isRecord(value)) {
		throw invalidOutput();
	}

	if (typeof value.text === 'string' && value.bytes === undefined) {
		return value.text;
	}

	if (typeof value.bytes !== 'string' || value.text !== undefined) {
		throw invalidOutput();
	}

	const bytes = Buffer.from(value.bytes, 'base64');

	if (bytes.toString('base64') !== value.bytes) {
		throw invalidOutput();
	}

	return new TextDecoder('utf-8', { fatal: isPath }).decode(bytes);
}

function lineText(value: unknown): string {
	let text = decode(value);

	if (text.endsWith('\n')) {
		text = text.slice(0, -1);

		if (text.endsWith('\r')) {
			text = text.slice(0, -1);
		}
	}

	if (text.includes('\n')) {
		throw invalidOutput();
	}

	return text;
}

function adjacent(
	lines: ReadonlyMap<number, string>,
	line: number,
	count: number,
	direction: -1 | 1
): string[] {
	const result: string[] = [];

	for (let offset = 1; offset <= count; offset++) {
		const text = lines.get(line + offset * direction);

		if (text === undefined) {
			break;
		}

		result.push(text);
	}

	return direction === -1 ? result.toReversed() : result;
}

export class GrepOutput implements SearchOutput<GrepResult> {
	readonly #context: number;
	readonly #limit: number;
	readonly #matches: OrderedResults<GrepMatch>;
	readonly #output: DelimitedOutput;
	#file: FileLines | undefined;
	#hasSummary = false;

	constructor(context: number, limit: number) {
		this.#context = context;
		this.#limit = limit;
		this.#matches = new OrderedResults(
			limit,
			(left, right) =>
				Buffer.compare(Buffer.from(left.path), Buffer.from(right.path)) ||
				left.line - right.line
		);
		this.#output = new DelimitedOutput('grep', '\n', (row) => {
			this.#accept(row);
		});
	}

	#end(data: Record<string, unknown>, file: FileLines): void {
		if (
			data.binary_offset !== null &&
			(typeof data.binary_offset !== 'number' ||
				!Number.isSafeInteger(data.binary_offset) ||
				data.binary_offset < 0)
		) {
			throw invalidOutput();
		}

		this.#file = undefined;

		if (data.binary_offset !== null) {
			return;
		}

		for (const line of file.matches) {
			const text = file.lines.get(line);

			if (text === undefined) {
				throw invalidOutput();
			}

			this.#matches.add({
				path: file.path,
				line,
				text,
				before: adjacent(file.lines, line, this.#context, -1),
				after: adjacent(file.lines, line, this.#context, 1)
			});
		}
	}

	#accept(row: string): void {
		if (this.#hasSummary) {
			throw invalidOutput();
		}

		const event: unknown = JSON.parse(row);

		if (!isRecord(event) || !isRecord(event.data)) {
			throw invalidOutput();
		}

		const { data } = event;

		if (event.type === 'summary') {
			if (this.#file !== undefined) {
				throw invalidOutput();
			}

			this.#hasSummary = true;

			return;
		}

		const filename = decode(data.path, true).replace(/^\.\//u, '');

		if (event.type === 'begin') {
			if (this.#file !== undefined) {
				throw invalidOutput();
			}

			this.#file = {
				path: filename,
				lines: new Map(),
				matches: new Set(),
				lastLine: 0,
				lastMatch: 0
			};

			return;
		}

		const file = this.#file;

		if (file?.path !== filename) {
			throw invalidOutput();
		}

		if (event.type === 'end') {
			this.#end(data, file);

			return;
		}

		if (
			(event.type !== 'match' && event.type !== 'context') ||
			typeof data.line_number !== 'number' ||
			!Number.isSafeInteger(data.line_number) ||
			data.line_number <= file.lastLine
		) {
			throw invalidOutput();
		}

		file.lastLine = data.line_number;

		const canRetainMatch = file.matches.size <= this.#limit;

		if (canRetainMatch || data.line_number - file.lastMatch <= this.#context) {
			file.lines.set(data.line_number, lineText(data.lines));
		}

		if (!(canRetainMatch && event.type === 'match')) {
			return;
		}

		file.matches.add(data.line_number);
		file.lastMatch = data.line_number;
	}

	write(data: Uint8Array): void {
		this.#output.write(data);
	}

	finish(): GrepResult {
		this.#output.finish();

		if (!this.#hasSummary || this.#file !== undefined) {
			throw invalidOutput();
		}

		return {
			matches: this.#matches.values,
			truncated: this.#matches.isTruncated
		};
	}
}
