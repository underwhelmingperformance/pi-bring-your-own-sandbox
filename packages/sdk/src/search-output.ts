import type { FindResult } from './contracts.js';
import { SandboxOperationError } from './errors.js';
import { OrderedResults } from './ordered-results.js';

export interface SearchOutput<Result> {
	readonly write: (data: Uint8Array) => void;
	readonly finish: () => Result;
}

interface SearchIdentity {
	readonly operation: 'find' | 'grep';
	readonly providerId: string;
}

const maximumRecordBytes = 1_048_576;
const decoderChunkBytes = 16_384;

export class DelimitedOutput {
	readonly #decoder = new TextDecoder('utf-8', { fatal: true });
	readonly #delimiter: string;
	readonly #identity: SearchIdentity;
	readonly #accept: (entry: string) => void;
	#pending = '';
	#pendingBytes = 0;

	constructor(
		identity: SearchIdentity,
		delimiter: string,
		accept: (entry: string) => void
	) {
		this.#identity = identity;
		this.#delimiter = delimiter;
		this.#accept = accept;
	}

	#consume(text: string): void {
		let start = 0;

		while (start < text.length) {
			const separator = text.indexOf(this.#delimiter, start);
			const fragment = text.slice(
				start,
				separator === -1 ? text.length : separator
			);

			this.#pendingBytes += Buffer.byteLength(fragment);

			if (this.#pendingBytes > maximumRecordBytes) {
				throw new SandboxOperationError(this.#identity);
			}

			this.#pending += fragment;

			if (separator === -1) {
				return;
			}

			const record = this.#pending;

			this.#pending = '';
			this.#pendingBytes = 0;
			this.#accept(record);

			start = separator + this.#delimiter.length;
		}
	}

	write(data: Uint8Array): void {
		try {
			for (
				let offset = 0;
				offset < data.byteLength;
				offset += decoderChunkBytes
			) {
				const chunk = data.subarray(offset, offset + decoderChunkBytes);

				this.#consume(this.#decoder.decode(chunk, { stream: true }));
			}
		} catch (error) {
			throw new SandboxOperationError(this.#identity, { cause: error });
		}
	}

	finish(): void {
		try {
			this.#consume(this.#decoder.decode());
		} catch (error) {
			throw new SandboxOperationError(this.#identity, { cause: error });
		}

		if (this.#pending !== '') {
			throw new SandboxOperationError(this.#identity);
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
		this.#output = new DelimitedOutput(
			{ operation: 'find', providerId: 'passthrough' },
			'\0',
			(entry) => {
				if (entry === '') {
					throw new SandboxOperationError({
						operation: 'find',
						providerId: 'passthrough'
					});
				}

				this.#paths.add(entry.replace(/^\.\//u, ''));
			}
		);
	}

	write(data: Uint8Array): void {
		this.#output.write(data);
	}

	finish(): FindResult {
		this.#output.finish();

		return { paths: this.#paths.values, truncated: this.#paths.isTruncated };
	}
}
