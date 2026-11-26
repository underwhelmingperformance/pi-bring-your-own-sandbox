import { InvalidSandboxConfigError } from './errors.js';
import {
	basePassthroughProfile,
	openPassthrough,
	probePassthrough
} from './passthrough.js';
import type { ProviderServiceV1 } from './protocol.js';
import { isRecord } from './validation.js';

type Inventory = Awaited<ReturnType<typeof probePassthrough>>;

function provider(inventory?: Inventory): ProviderServiceV1 {
	return Object.freeze<ProviderServiceV1>({
		id: 'passthrough',
		label: 'Host execution without isolation',
		profiles: {
			open: [inventory?.profile ?? basePassthroughProfile],
			copy: []
		},
		configure(input: unknown) {
			if (!isRecord(input) || Object.keys(input).length > 0) {
				throw new InvalidSandboxConfigError({
					operation: 'configure',
					providerId: 'passthrough'
				});
			}

			return {
				open: (request, context) =>
					openPassthrough(
						request.hostWorkspace,
						context,
						inventory,
						request.paths
					)
			};
		}
	});
}

export const passthroughProvider = provider();

export async function createPassthroughProvider(
	workspace: string
): Promise<ProviderServiceV1> {
	return provider(await probePassthrough(workspace));
}
