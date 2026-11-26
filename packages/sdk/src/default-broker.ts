import { SandboxBroker } from './broker.js';
import { reportCleanup } from './cleanup-report.js';
import type { SandboxHost } from './contracts.js';
import { discoverBroker, discoverProviders } from './discovery.js';
import {
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import { createPassthroughProvider } from './passthrough-provider.js';
import {
	bindProtocolAddress,
	isPiBound,
	protocolAddress
} from './protocol-address.js';
import {
	collectProtocolReplies,
	onProtocolRequest,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import { buildAdvertisement } from './protocol-payloads.js';
import { compareBuilds, sharedFeatureLevel } from './protocol-version.js';
import { createRuntimeSettings } from './runtime-settings.js';
import { checker } from './schemas.js';
import { ensureBroker } from './service.js';

const isBuildAdvertisement = checker(buildAdvertisement);
const candidates = new WeakSet<SandboxHost>();

export function bindFactory(pi: SandboxHost, extensionSource: string): void {
	if (isPiBound(pi)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	const identity = bindProtocolAddress(pi.events, extensionSource);

	if (candidates.has(pi)) {
		return;
	}

	candidates.add(pi);
	onProtocolRequest(
		pi.events,
		RUNTIME_CHANNEL,
		identity,
		'get-builds',
		() => ({
			type: 'build',
			activate() {
				ensureBroker(pi.events, (id) => {
					const settings = createRuntimeSettings(pi);

					const broker = new SandboxBroker(
						id,
						pi,
						{
							diagnostics: settings.diagnostics,
							protocol: identity,
							providers: async (context) => [
								await createPassthroughProvider(context.cwd),
								...discoverProviders(pi.events)
							],
							readConfig: (context) => settings.read(context)
						},
						'owner'
					);

					pi.on('session_shutdown', async (_event, context) => {
						reportCleanup(pi, context, await broker.close(context));
					});

					return broker;
				});
			}
		}),
		'advertisement'
	);

	pi.on('session_start', () => {
		ensureSandboxService(pi);
	});
}

export function ensureSandboxService(pi: SandboxHost) {
	if (!isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	const existing = discoverBroker(pi.events);

	if (existing !== undefined) {
		return existing;
	}

	const local = protocolAddress(pi.events);
	const available = collectProtocolReplies(pi.events, RUNTIME_CHANNEL, local, {
		type: 'get-builds'
	});
	const builds = available.map((reply) => {
		sharedFeatureLevel(local, reply);

		if (
			reply.kind !== 'advertisement' ||
			!isBuildAdvertisement(reply.payload)
		) {
			throw new InvalidSandboxDeclarationError({ operation: 'discover' });
		}

		return { identity: reply, activate: reply.payload.activate };
	});
	const selected = builds.toSorted((a, b) =>
		compareBuilds(b.identity, a.identity)
	)[0];

	selected?.activate();

	const service = discoverBroker(pi.events);

	if (service === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	return service;
}
