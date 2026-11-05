export interface Clock {
	readonly monotonicNow: () => number;
	readonly wallNow: () => number;
	readonly schedule: (delayMs: number, callback: () => void) => () => void;
}

export const systemClock: Clock = {
	monotonicNow: () => performance.now(),
	wallNow: () => Date.now(),
	schedule(delayMs, callback) {
		const timer = setTimeout(callback, delayMs);

		return () => {
			clearTimeout(timer);
		};
	}
};
