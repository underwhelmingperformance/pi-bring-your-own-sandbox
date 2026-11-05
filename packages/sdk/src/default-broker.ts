import { SandboxBroker } from './broker.js';
import { builtinProviders } from './builtin-providers.js';
import type { SandboxHost } from './contracts.js';
import { discoverProviders } from './discovery.js';
import { runtimeSettings } from './runtime-settings.js';
import { ensureBroker } from './service.js';

export function ensureSandboxService(pi: SandboxHost, agentDirectory?: string) {
	return ensureBroker(
		pi.events,
		(id) =>
			new SandboxBroker(id, pi, {
				providers: () => [
					...builtinProviders.providers,
					...discoverProviders(pi.events)
				],
				readConfig: () =>
					runtimeSettings(
						pi,
						agentDirectory === undefined ? undefined : { agentDirectory }
					).read()
			})
	);
}
