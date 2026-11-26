import type { SandboxHost, SandboxHostOptions } from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { bindRuntimeSettings } from './runtime-settings.js';
import { checker } from './schemas.js';
import { hostOptionsSchema } from './service-schemas.js';

const isHostOptions = checker(hostOptionsSchema);

/**
Bind cleanup defaults or a normal executor for an embedded Pi runtime. Call
once from the host's first extension factory, before other SDK services exist.
Every SDK copy then discovers the same service. A late or repeated binding
fails; it cannot change an existing service's configuration.
*/
export function initialiseSandboxHost(
	pi: SandboxHost,
	extensionSource: string,
	options: SandboxHostOptions
): void {
	if (!isHostOptions(options)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	bindRuntimeSettings(pi, extensionSource, options);
}
