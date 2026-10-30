export class OrderedResults<Value> {
	readonly #limit: number;
	readonly #compare: (left: Value, right: Value) => number;
	readonly #values: Value[] = [];
	#isTruncated = false;

	constructor(limit: number, compare: (left: Value, right: Value) => number) {
		this.#limit = limit;
		this.#compare = compare;
	}

	add(value: Value): void {
		let start = 0;
		let end = this.#values.length;
		while (start < end) {
			const middle = Math.floor((start + end) / 2);
			const previous = this.#values[middle];
			if (previous !== undefined && this.#compare(previous, value) < 0) {
				start = middle + 1;
				continue;
			}
			end = middle;
		}
		if (this.#values.length >= this.#limit) {
			this.#isTruncated = true;
		}
		if (start >= this.#limit) {
			return;
		}
		this.#values.splice(start, 0, value);
		if (this.#values.length > this.#limit) {
			this.#values.pop();
		}
	}

	get values(): readonly Value[] {
		return [...this.#values];
	}

	get isTruncated(): boolean {
		return this.#isTruncated;
	}
}
