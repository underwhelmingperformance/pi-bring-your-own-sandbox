import { observe } from './lifecycle.js';

/**
Serialises complete mutations, including result validation and health updates.
Callbacks must report uncertainty before returning so the next mutation sees the failed state.
*/
export class MutationQueue {
	#tail: Promise<void> = Promise.resolve();

	run<Value>(execute: () => Promise<Value>): Promise<Value> {
		const previous = this.#tail;
		const pending = Promise.try(async () => {
			await previous;

			return execute();
		});

		this.#tail = Promise.try(async () => {
			await observe(pending);
		});

		return pending;
	}
}
