/**
Schedules a callback for an absolute SDK deadline, including waits beyond Node's
single-timer range.
*/
export class DeadlineTimer {
	#expiresAt: number;
	readonly #onExpire: () => void;
	#timer: ReturnType<typeof setTimeout> | undefined;

	/**
	Converts a Unix-epoch deadline to a monotonic wait.
	*/
	constructor(deadline: number, onExpire: () => void) {
		this.#expiresAt = performance.now() + Math.max(0, deadline - Date.now());
		this.#onExpire = onExpire;
		this.#schedule();
	}

	#schedule(): void {
		const remaining = this.#expiresAt - performance.now();

		this.#timer = setTimeout(
			() => {
				if (performance.now() < this.#expiresAt) {
					this.#schedule();

					return;
				}

				this.#onExpire();
			},
			Math.min(Math.max(0, remaining), 2_147_483_647)
		);
	}

	/**
	Replaces the pending wait after the broker publishes a cleanup deadline.
	*/
	reset(deadline: number): void {
		clearTimeout(this.#timer);
		this.#expiresAt = performance.now() + Math.max(0, deadline - Date.now());
		this.#schedule();
	}

	/**
	Cancels callback delivery and releases the pending timer.
	*/
	dispose(): void {
		clearTimeout(this.#timer);
	}
}
