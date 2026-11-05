/**
Schedules expiration from the broker's current remaining budget. Long waits use
multiple native timers and every callback rechecks the same allowance.
*/
export class DeadlineTimer {
	readonly #remainingMs: () => number;
	readonly #onExpire: () => void;
	#timer: ReturnType<typeof setTimeout> | undefined;

	/**
	The callback must calculate the remaining allowance from monotonic time.
	*/
	constructor(remainingMs: () => number, onExpire: () => void) {
		this.#remainingMs = remainingMs;
		this.#onExpire = onExpire;
		this.#schedule();
	}

	#schedule(): void {
		const remaining = this.#remainingMs();

		this.#timer = setTimeout(
			() => {
				if (this.#remainingMs() > 0) {
					this.#schedule();

					return;
				}

				this.#onExpire();
			},
			Math.min(Math.max(0, remaining), 2_147_483_647)
		);
	}

	/**
	Reschedules against the cleanup budget published before cancellation.
	*/
	reset(): void {
		clearTimeout(this.#timer);
		this.#schedule();
	}

	/**
	Cancels callback delivery and releases the pending timer.
	*/
	dispose(): void {
		clearTimeout(this.#timer);
	}
}
