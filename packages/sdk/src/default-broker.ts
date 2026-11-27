import { randomUUID } from 'node:crypto';

import { SandboxBroker } from './broker.js';
import { reportCleanup } from './cleanup-report.js';
import { SandboxSession } from './context.js';
import type { SandboxContext, SandboxHost } from './contracts.js';
import { discoverBroker, discoverProviders } from './discovery.js';
import {
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import { appendLedgerEntry } from './escalation-ledger.js';
import { createPassthroughProvider } from './passthrough-provider.js';
import {
	bindProtocolAddress,
	isPiBound,
	protocolAddress
} from './protocol-address.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import {
	collectProtocolReplies,
	onProtocolRequest,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import type { BrokerStarter } from './protocol-payloads.js';
import { buildAdvertisement, startBrokerRequest } from './protocol-payloads.js';
import { compareBuilds, sharedFeatureLevel } from './protocol-version.js';
import { createRuntimeSettings } from './runtime-settings.js';
import { checker } from './schemas.js';
import { ensureBroker } from './service.js';

const isBuildAdvertisement = checker(buildAdvertisement);
const isStartBrokerRequest = checker(startBrokerRequest);
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

	const candidateId = randomUUID();
	let starting: Promise<void> | undefined;

	async function start(context: SandboxContext): Promise<void> {
		const session = await SandboxSession.capture(context);

		ensureBroker(pi.events, (id) => {
			const settings = createRuntimeSettings(pi);
			const broker = new SandboxBroker(
				id,
				pi,
				{
					diagnostics: settings.diagnostics,
					appendLedger(entry) {
						appendLedgerEntry(pi, entry);
					},
					protocol: identity,
					providers: async (configContext) => [
						await createPassthroughProvider(configContext.cwd),
						...discoverProviders(pi.events)
					],
					readConfig: (configContext) => settings.read(configContext)
				},
				session
			);

			pi.on('session_shutdown', async (_event, context) => {
				reportCleanup(pi, context, await broker.close(context));
			});

			return broker;
		});
	}

	onProtocolRequest(
		pi.events,
		RUNTIME_CHANNEL,
		identity,
		'get-builds',
		() => ({ type: 'build', candidateId }),
		'advertisement'
	);
	onProtocolRequest(
		pi.events,
		RUNTIME_CHANNEL,
		identity,
		'start-broker',
		(request) => {
			const { payload } = request;

			if (
				request.major === identity.major &&
				isStartBrokerRequest(payload) &&
				payload.candidateId === candidateId
			) {
				payload.receive(identity, (context) => (starting ??= start(context)));
			}

			return;
		}
	);

	pi.on('session_start', (_event, context) => startSandboxRuntime(pi, context));
}

export async function startSandboxRuntime(
	pi: SandboxHost,
	context: SandboxContext
): Promise<void> {
	if (!isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'discover' });
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

		return { identity: reply, candidateId: reply.payload.candidateId };
	});
	const selected = builds.toSorted((a, b) =>
		compareBuilds(b.identity, a.identity)
	)[0];

	if (selected === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	if (discoverBroker(pi.events) !== undefined) {
		return;
	}

	const handoff: { start?: BrokerStarter } = {};

	collectProtocolReplies(pi.events, RUNTIME_CHANNEL, local, {
		type: 'start-broker',
		candidateId: selected.candidateId,
		receive(identity: ProtocolIdentity, start: BrokerStarter) {
			const expected = selected.identity;

			if (
				handoff.start !== undefined ||
				identity.extensionSource !== expected.extensionSource ||
				identity.buildId !== expected.buildId ||
				identity.packageVersion !== expected.packageVersion ||
				identity.major !== expected.major ||
				identity.featureLevel !== expected.featureLevel
			) {
				throw new InvalidSandboxDeclarationError({ operation: 'discover' });
			}

			handoff.start = start;
		}
	});

	if (handoff.start === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	await handoff.start(context);
}

export function ensureSandboxService(pi: SandboxHost) {
	if (!isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	const service = discoverBroker(pi.events);

	if (service === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	return service;
}
