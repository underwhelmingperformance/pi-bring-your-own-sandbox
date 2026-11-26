import { describe, it } from 'vitest';

import { resolveCleanupBudgets } from './cleanup-budgets.js';
import {
	providerContractCases,
	usingProviderFixture
} from './provider-contract-suite.js';
import type {
	SandboxProviderFixtureOptions,
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';

/**
Registers Vitest cases for a provider's selected operations and policies. Call
this at test-module scope. Every case opens and disposes a fresh backend and
runs fixture cleanup even if validation, opening or an assertion fails.

The suite checks supplied probes, not universal isolation. Provider authors
must test runtime-specific escape paths and verify target termination and
resource release independently.
@typeParam Config - Validated configuration accepted by the provider.
*/
export function defineSandboxProviderTests<Config>(
	options:
		SandboxProviderTestOptions<Config> | SandboxProviderFixtureOptions<Config>
): void {
	const cleanup = resolveCleanupBudgets(options.cleanup);
	const testTimeout =
		(options.timeoutMs ?? 10_000) * 5 +
		3 * cleanup.disposalTimeoutMs +
		2 * cleanup.cancellationGraceMs;

	describe(options.label, async () => {
		let registered: SandboxProviderTestOptions<Config>;

		if ('provider' in options) {
			registered = options;
		} else {
			const fixture = await options.createFixture();

			try {
				registered = { ...options, provider: fixture.provider };
			} finally {
				await fixture.cleanup();
			}
		}

		const isFocused =
			options.workspaceVisibility !== undefined ||
			options.capabilities !== undefined;
		const cases = isFocused
			? providerContractCases(registered)
			: (['open', 'copy'] as const).flatMap((mode) =>
					registered.provider.profiles[mode].flatMap((profile, index) => {
						const selection: SandboxProviderTestSelection = { mode, profile };

						return providerContractCases(registered, selection).map(
							(entry) => ({
								...entry,
								label: `${mode} profile ${String(index + 1)}: ${entry.label}`
							})
						);
					})
				);

		for (const entry of cases) {
			it(
				entry.label,
				() => usingProviderFixture(registered, entry),
				testTimeout +
					(entry.operation === 'independent-disposal'
						? (options.timeoutMs ?? 10_000) + cleanup.disposalTimeoutMs
						: 0)
			);
		}
	});
}
