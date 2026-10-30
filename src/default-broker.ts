import { getAgentDir } from '@earendil-works/pi-coding-agent';

import { SandboxBroker } from './broker.js';
import { readConfig } from './config.js';
import type { SandboxHost } from './contracts.js';
import { discoverProviders } from './discovery.js';
import { passthroughProvider } from './passthrough-provider.js';
import { ensureBroker } from './service.js';

export function ensureSandboxService(pi: SandboxHost, agentDirectory?: string) {
	return ensureBroker(
		pi.events,
		(id) =>
			new SandboxBroker(id, pi, {
				providers: () => [passthroughProvider, ...discoverProviders(pi.events)],
				readConfig: (context) =>
					readConfig({
						agentDirectory: agentDirectory ?? getAgentDir(),
						workspace: context.workspace,
						isProjectTrusted: context.isProjectTrusted
					})
			})
	);
}
