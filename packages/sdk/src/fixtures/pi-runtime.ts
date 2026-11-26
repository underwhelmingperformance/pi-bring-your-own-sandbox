import type {
	AgentSessionRuntime,
	InlineExtension
} from '@earendil-works/pi-coding-agent';

import type { RuntimeOptions } from '../../../../test-support/pi-runtime.js';
import { withPiRuntime as runPi } from '../../../../test-support/pi-runtime.js';
import { bindFactory } from '../default-broker.js';
import { hasProtocolAddress } from '../protocol-address.js';

export function withPiRuntime(
	extensions: readonly InlineExtension[],
	execute: (
		runtime: AgentSessionRuntime,
		errors: readonly unknown[]
	) => Promise<void>,
	options?: RuntimeOptions & { readonly bindFixtureSources?: boolean }
): Promise<void> {
	if (options?.bindFixtureSources === false) {
		return runPi(extensions, execute, options);
	}

	return runPi(
		extensions.map((extension) => {
			const item =
				typeof extension === 'function'
					? { name: extension.name || 'fixture', factory: extension }
					: extension;

			return {
				...item,
				async factory(pi) {
					await item.factory(pi);

					if (!hasProtocolAddress(pi.events)) {
						bindFactory(pi, `<inline:${item.name}>`);
					}
				}
			};
		}),
		execute,
		options
	);
}
