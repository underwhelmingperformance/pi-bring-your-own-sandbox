import type { SandboxHost, SandboxHostOptions } from './contracts.js';
import { discoverBroker } from './discovery.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import { bindRuntimeSettings } from './runtime-settings.js';
import { checker } from './schemas.js';
import { hostOptionsSchema } from './service-schemas.js';

const isHostOptions = checker(hostOptionsSchema);

/**
Bind an embedded Pi runtime to its personal configuration directory. Call once
from the host's first extension factory, before the broker or consumer factories
run. Every SDK copy then discovers the same service. A late or repeated binding
fails; it cannot change an existing service's configuration.
*/
export function initialiseSandboxHost(
	pi: SandboxHost,
	options: SandboxHostOptions
): void {
	if (!isHostOptions(options)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	if (discoverBroker(pi.events) !== undefined) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	bindRuntimeSettings(pi, options);
}
