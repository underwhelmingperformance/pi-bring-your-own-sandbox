import type { FindResult } from './contracts.js';
import { SandboxOperationError } from './errors.js';
import { OrderedResults } from './ordered-results.js';

export interface SearchOutput<Result> {
	readonly write: (data: Uint8Array) => void;
	readonly finish: () => Result;
}

export class DelimitedOutput {
	readonly #decoder = new TextDecoder('utf-8', { fatal: true });
	readonly #delimiter: string;
	readonly #operation: 'find' | 'grep';
	readonly #accept: (entry: string) => void;
	#pending = '';

	constructor(
		operation: 'find' | 'grep',
		delimiter: string,
		accept: (entry: string) => void
	) {
		this.#operation = operation;
		this.#delimiter = delimiter;
		this.#accept = accept;
	}

	#consume(text: string): void {
		this.#pending += text;
		let offset = this.#pending.indexOf(this.#delimiter);
		while (offset !== -1) {
			const entry = this.#pending.slice(0, offset);
			this.#pending = this.#pending.slice(offset + this.#delimiter.length);
			this.#accept(entry);
			offset = this.#pending.indexOf(this.#delimiter);
		}
	}

	write(data: Uint8Array): void {
		this.#consume(this.#decoder.decode(data, { stream: true }));
	}

	finish(): void {
		this.#consume(this.#decoder.decode());
		if (this.#pending !== '') {
			throw new SandboxOperationError({
				operation: this.#operation,
				providerId: 'passthrough'
			});
		}
	}
}

export class FindOutput implements SearchOutput<FindResult> {
	readonly #paths: OrderedResults<string>;
	readonly #output: DelimitedOutput;

	constructor(limit: number) {
		this.#paths = new OrderedResults(limit, (left, right) =>
			Buffer.compare(Buffer.from(left), Buffer.from(right))
		);
		this.#output = new DelimitedOutput('find', '\0', (entry) => {
			if (entry === '') {
				throw new SandboxOperationError({
					operation: 'find',
					providerId: 'passthrough'
				});
			}
			this.#paths.add(entry.replace(/^\.\//u, ''));
		});
	}

	write(data: Uint8Array): void {
		this.#output.write(data);
	}

	finish(): FindResult {
		this.#output.finish();
		return { paths: this.#paths.values, truncated: this.#paths.isTruncated };
	}
}
