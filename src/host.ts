import path from 'node:path';

import type { SandboxHost, SandboxHostOptions } from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { discoverBroker } from './discovery.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import { isSafeText } from './process-input.js';

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
	if (
		!isSafeText(options.agentDirectory) ||
		!path.isAbsolute(options.agentDirectory)
	) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	if (discoverBroker(pi.events) !== undefined) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	ensureSandboxService(pi, options.agentDirectory);
}
