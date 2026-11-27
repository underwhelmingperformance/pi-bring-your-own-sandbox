import { failedCloseReport } from './cleanup-report.js';
import type {
	SandboxHost,
	SandboxHostHandle,
	SandboxHostOptions
} from './contracts.js';
import { bindFactory } from './default-broker.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import { isPiBound } from './protocol-address.js';
import { registerHostOptions } from './runtime-participant.js';
import { checker } from './schemas.js';
import { hostOptionsSchema } from './service-schemas.js';

const isHostOptions = checker(hostOptionsSchema);

/**
Register the embedding host during its Pi extension factory. The returned
handle shares the elected broker's shutdown operation after session startup.
*/
export function initialiseSandboxHost(
	pi: SandboxHost,
	extensionSource: string,
	options: SandboxHostOptions = {}
): SandboxHostHandle {
	if (isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'configure' });
	}

	if (!isHostOptions(options)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	bindFactory(pi, extensionSource);

	let close: SandboxHostHandle['close'] | undefined;

	registerHostOptions(pi, options, (ownerClose) => {
		close = ownerClose;
	});

	return Object.freeze<SandboxHostHandle>({
		close() {
			return close === undefined
				? Promise.resolve(
						failedCloseReport(
							new SandboxInitialisationError({ operation: 'dispose' })
						)
					)
				: close();
		}
	});
}
