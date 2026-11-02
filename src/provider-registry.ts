import {
	DuplicateProviderError,
	InvalidSandboxDeclarationError
} from './errors.js';
import type { ProviderServiceV1 } from './protocol.js';
import { isProviderInfo } from './validation.js';

export class ProviderRegistry {
	readonly #ids = new Set<string>();
	readonly defaultProvider: ProviderServiceV1;
	readonly providers: readonly ProviderServiceV1[];

	constructor(
		defaultProvider: ProviderServiceV1,
		additional: readonly ProviderServiceV1[] = []
	) {
		this.defaultProvider = defaultProvider;
		this.providers = Object.freeze([defaultProvider, ...additional]);

		for (const provider of this.providers) {
			if (!isProviderInfo(provider)) {
				throw new InvalidSandboxDeclarationError({
					operation: 'discover',
					providerId: provider.id
				});
			}

			if (this.#ids.has(provider.id)) {
				throw new DuplicateProviderError({
					operation: 'discover',
					providerId: provider.id
				});
			}

			this.#ids.add(provider.id);
		}
	}

	has(id: string): boolean {
		return this.#ids.has(id);
	}
}
