import { SandboxBroker } from './broker.js';
import { builtinProviders } from './builtin-providers.js';
import type { SandboxHost } from './contracts.js';
import { discoverProviders } from './discovery.js';
import { runtimeSettings } from './runtime-settings.js';
import { ensureBroker } from './service.js';

export function ensureSandboxService(pi: SandboxHost) {
	return ensureBroker(
		pi.events,
		(id) =>
			new SandboxBroker(id, pi, {
				diagnostics: runtimeSettings(pi).diagnostics,
				providers: () => [
					...builtinProviders.providers,
					...discoverProviders(pi.events)
				],
				readConfig: (context) => runtimeSettings(pi).read(context)
			})
	);
}
