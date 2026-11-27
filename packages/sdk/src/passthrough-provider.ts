import {
	basePassthroughProfile,
	openPassthrough,
	probePassthrough
} from './passthrough.js';
import type { ConfiguredProviderV1, ProviderServiceV1 } from './protocol.js';

type Inventory = Awaited<ReturnType<typeof probePassthrough>>;

type PassthroughProvider = ProviderServiceV1 & {
	readonly prepare: () => ConfiguredProviderV1;
};

function provider(inventory?: Inventory): PassthroughProvider {
	return Object.freeze<PassthroughProvider>({
		id: 'passthrough',
		label: 'Host execution without isolation',
		profiles: {
			open: [inventory?.profile ?? basePassthroughProfile],
			copy: []
		},
		prepare() {
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
): Promise<PassthroughProvider> {
	return provider(await probePassthrough(workspace));
}
