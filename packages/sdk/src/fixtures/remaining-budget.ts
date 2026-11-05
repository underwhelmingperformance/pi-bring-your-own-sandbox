export function remainingBudget(timeoutMs: number): () => number {
	const expiresAt = performance.now() + timeoutMs;

	return () => Math.max(0, expiresAt - performance.now());
}
