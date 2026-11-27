import { describe, it } from 'vitest';

import {
	providerContractCases,
	usingProviderFixture
} from '../provider-contract-suite.js';
import type { SandboxProviderTestOptions } from '../provider-test-contracts.js';

export function defineFixtureOperationTests<Config>(
	options: SandboxProviderTestOptions<Config>
): void {
	describe(options.label, () => {
		for (const entry of providerContractCases(options)) {
			it(entry.label, () => usingProviderFixture(options, entry), 30_000);
		}
	});
}
