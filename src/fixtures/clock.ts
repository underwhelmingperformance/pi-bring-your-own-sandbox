import type { Clock } from '../clock.js';

interface Timer {
	readonly expiresAt: number;
	readonly callback: () => void;
}

export class FakeClock implements Clock {
	#now = 0;
	readonly #timers = new Set<Timer>();
	wallTime = 1000;

	monotonicNow = (): number => this.#now;
	wallNow = (): number => this.wallTime;

	schedule(delayMs: number, callback: () => void): () => void {
		const timer = { expiresAt: this.#now + delayMs, callback };

		this.#timers.add(timer);

		return () => {
			this.#timers.delete(timer);
		};
	}

	get pendingTimers(): number {
		return this.#timers.size;
	}

	advance(milliseconds: number): void {
		this.#now += milliseconds;
	}

	dispatch(): void {
		const due = [...this.#timers]
			.filter((timer) => timer.expiresAt <= this.#now)
			.toSorted((left, right) => left.expiresAt - right.expiresAt);

		for (const timer of due) {
			if (!this.#timers.delete(timer)) {
				continue;
			}

			timer.callback();
		}
	}
}
