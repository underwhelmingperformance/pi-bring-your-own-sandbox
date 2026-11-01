import { getAgentDir } from '@earendil-works/pi-coding-agent';

import type { SandboxConfig } from './config.js';
import { readConfig } from './config.js';
import type { SandboxHost, SandboxHostOptions } from './contracts.js';
import { InvalidSandboxRequestError } from './errors.js';
import { ensureExtensionService } from './extension-services.js';
import { checker } from './schemas.js';
import { runtimeSettingsSchema } from './service-schemas.js';

const isRuntimeSettings = checker(runtimeSettingsSchema);

export interface RuntimeSettingsV1 {
	readonly id: string;
	readonly lifetime: AbortSignal;
	readonly close: () => void;
	readonly read: () => Promise<SandboxConfig>;
	readonly normalExecutor?: SandboxHostOptions['normalExecutor'];
}

export function runtimeSettings(
	pi: SandboxHost,
	options?: SandboxHostOptions
): RuntimeSettingsV1 {
	return ensureExtensionService(
		pi.events,
		'pi-byos:settings:v1',
		isRuntimeSettings,
		(id) => {
			const directory = options?.agentDirectory ?? getAgentDir();
			let config: Promise<SandboxConfig> | undefined;
			const lifetime = new AbortController();

			pi.on('session_shutdown', () => {
				lifetime.abort();
			});

			return {
				id,
				lifetime: lifetime.signal,
				close: () => {
					lifetime.abort();
				},
				...(options?.normalExecutor !== undefined && {
					normalExecutor: options.normalExecutor
				}),
				read() {
					config ??= readConfig({ agentDirectory: directory });

					return config;
				}
			};
		}
	);
}

export function bindRuntimeSettings(
	pi: SandboxHost,
	options: SandboxHostOptions
): void {
	const state = { exists: false };

	pi.events.emit('pi-byos:settings:v1', {
		kind: 'pi-byos.discover',
		discoveryVersion: 1,
		reply() {
			state.exists = true;
		}
	});

	if (state.exists) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	runtimeSettings(pi, options);
}
