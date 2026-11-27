import { randomUUID } from 'node:crypto';

import { SandboxBroker } from './broker.js';
import { reportCleanup } from './cleanup-report.js';
import { inspectContext, SandboxSession } from './context.js';
import type { SandboxContext, SandboxHost } from './contracts.js';
import { discoverBroker, discoverProviders } from './discovery.js';
import {
	ConflictingSandboxConfigError,
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
	protocolIdentitySchema,
	RUNTIME_CHANNEL
} from './protocol-envelope.js';
import type {
	BrokerPin,
	BrokerStarter,
	RuntimeCandidate
} from './protocol-payloads.js';
import {
	buildAdvertisement,
	connectRuntimeRequest,
	startBrokerRequest
} from './protocol-payloads.js';
import { compareBuilds, sharedFeatureLevel } from './protocol-version.js';
import type {
	RuntimeParticipant,
	RuntimeProvider
} from './runtime-participant.js';
import {
	areProtocolIdentitiesEqual,
	localRuntimeBindings
} from './runtime-participant.js';
import { createRuntimeSettings } from './runtime-settings.js';
import {
	runtimeParticipantSchema,
	shellSettingsSchema
} from './runtime-wire-schemas.js';
import { checker } from './schemas.js';
import { publishBroker } from './service.js';
import { ShellReviewRoutes } from './shell-review-routes.js';
import { snapshotProviderInfo } from './validation.js';

const isRuntimeParticipant = checker(runtimeParticipantSchema);
const isShellSettings = checker(shellSettingsSchema);
const isBuildAdvertisement = checker(buildAdvertisement);
const isConnectRuntimeRequest = checker(connectRuntimeRequest);
const isProtocolIdentity = checker(protocolIdentitySchema);
const isStartBrokerRequest = checker(startBrokerRequest);
const candidates = new WeakSet<SandboxHost>();

interface Election extends RuntimeCandidate {
	readonly id: string;
	readonly sessionId: string;
}

function invalidBootstrap() {
	return new InvalidSandboxDeclarationError({ operation: 'discover' });
}

function connectParticipant(
	pi: SandboxHost,
	selected: RuntimeCandidate,
	owner: BrokerPin,
	election: Election
): RuntimeParticipant {
	const handoff: { participant?: RuntimeParticipant; isInvalid?: true } = {};

	const replies = collectProtocolReplies(
		pi.events,
		RUNTIME_CHANNEL,
		owner.identity,
		{
			type: 'connect-runtime',
			electionId: election.id,
			candidateId: selected.candidateId,
			ownerCandidateId: owner.candidateId,
			brokerId: owner.brokerId,
			sessionId: election.sessionId,
			receive(identity: ProtocolIdentity, received: RuntimeParticipant) {
				if (
					handoff.participant !== undefined ||
					!isRuntimeParticipant(received) ||
					!areProtocolIdentitiesEqual(identity, selected.identity)
				) {
					handoff.isInvalid = true;

					return;
				}

				handoff.participant = received;
			}
		}
	);

	if (
		handoff.isInvalid === true ||
		handoff.participant === undefined ||
		replies.length > 0
	) {
		throw invalidBootstrap();
	}

	return handoff.participant;
}

function providerList(
	pi: SandboxHost,
	participants: readonly RuntimeParticipant[]
): readonly RuntimeProvider[] {
	const declarations = discoverProviders(pi.events);
	const contributions = participants.flatMap(({ providers }) => providers);

	if (declarations.length !== contributions.length) {
		throw invalidBootstrap();
	}

	return Object.freeze(
		declarations.map((info) => {
			const provider = contributions.find(({ id }) => id === info.id);

			if (
				provider === undefined ||
				!isProtocolIdentity(provider.protocol) ||
				!areProtocolIdentitiesEqual(provider.protocol, info.protocol) ||
				(typeof provider.configure === 'function') !==
					(info.unavailable === undefined)
			) {
				throw invalidBootstrap();
			}

			return Object.freeze({
				...info,
				...(provider.configure !== undefined && {
					configure: provider.configure.bind(provider)
				})
			});
		})
	);
}

export function bindFactory(pi: SandboxHost, extensionSource: string): void {
	if (isPiBound(pi)) {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	const identity = bindProtocolAddress(pi.events, extensionSource);

	if (candidates.has(pi)) {
		return;
	}

	candidates.add(pi);

	const bindings = localRuntimeBindings(pi);
	const candidateId = randomUUID();
	let starting: Promise<void> | undefined;
	let invitation: Election | undefined;
	let isConnected = false;

	async function start(
		context: SandboxContext,
		roster: readonly RuntimeCandidate[],
		election: Election
	): Promise<void> {
		const session = await SandboxSession.capture(context);

		if (session.sessionId !== election.sessionId) {
			throw invalidBootstrap();
		}

		const brokerId = randomUUID();
		const owner = Object.freeze<BrokerPin>({ identity, candidateId, brokerId });
		const participants = roster.map((member) =>
			connectParticipant(pi, member, owner, election)
		);
		const hosts = participants.flatMap(({ host }) =>
			host === undefined ? [] : [host]
		);

		if (hosts.length > 1) {
			throw new ConflictingSandboxConfigError({ operation: 'configure' });
		}

		let declared: readonly RuntimeProvider[] | undefined;
		const providers = () => (declared ??= providerList(pi, participants));
		const settings = createRuntimeSettings(providers, hosts[0]?.options);

		const shellSettings = Object.freeze({
			lifetime: settings.lifetime,
			async read(requestContext: SandboxContext) {
				session.check(requestContext, 'configure');

				const config = await settings.read(session.context);

				return Object.freeze({
					allowEscalation: config.allowEscalation ?? true,
					isUnrestrictedHost: config.selection.source === 'default',
					...(config.hostUserDataRoots !== undefined && {
						hostUserDataRoots: config.hostUserDataRoots
					})
				});
			}
		});

		if (!isShellSettings(shellSettings)) {
			throw invalidBootstrap();
		}

		const broker = new SandboxBroker(
			pi,
			{
				diagnostics: settings.diagnostics,
				appendLedger(entry) {
					appendLedgerEntry(pi, entry);
				},
				protocol: identity,
				providers: async (configContext) => [
					await createPassthroughProvider(configContext.cwd),
					...providers().map((provider) => ({
						...snapshotProviderInfo(provider),
						protocol: provider.protocol
					}))
				],
				readConfig: (configContext) => settings.read(configContext)
			},
			session,
			settings.close
		);

		for (const participant of participants) {
			for (const route of participant.shellRoutes) {
				const routes = new ShellReviewRoutes(
					route,
					broker,
					session,
					shellSettings
				);

				route.receive(routes.claim.bind(routes), shellSettings);
			}
		}

		pi.on('session_shutdown', async (_event, shutdownContext) => {
			reportCleanup(pi, shutdownContext, await broker.close());
		});

		publishBroker(pi.events, candidateId, () => broker, brokerId);
		bindings.owner = broker;
		hosts[0]?.receive(broker.close.bind(broker));

		for (const participant of participants) {
			participant.commit();
		}
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
				invitation !== undefined ||
				!isPiBound(pi) ||
				request.major !== identity.major ||
				!isStartBrokerRequest(payload)
			) {
				return;
			}

			const election = Object.freeze<Election>({
				id: request.requestId,
				candidateId: payload.candidateId,
				identity: Object.freeze({ ...payload.owner }),
				sessionId: payload.sessionId
			});

			invitation = election;

			if (
				election.candidateId === candidateId &&
				areProtocolIdentitiesEqual(identity, election.identity)
			) {
				payload.receive(
					identity,
					(context, roster) => (starting ??= start(context, roster, election))
				);
			}

			return;
		}
	);
	onProtocolRequest(
		pi.events,
		RUNTIME_CHANNEL,
		identity,
		'connect-runtime',
		(request) => {
			const { payload } = request;
			const election = invitation;

			if (
				election === undefined ||
				isConnected ||
				!isConnectRuntimeRequest(payload) ||
				payload.candidateId !== candidateId ||
				payload.electionId !== election.id ||
				payload.ownerCandidateId !== election.candidateId ||
				payload.sessionId !== election.sessionId ||
				!areProtocolIdentitiesEqual(request, election.identity)
			) {
				return;
			}

			isConnected = true;

			const owner = Object.freeze<BrokerPin>({
				identity: election.identity,
				candidateId: election.candidateId,
				brokerId: payload.brokerId
			});

			payload.receive(
				identity,
				Object.freeze<RuntimeParticipant>({
					providers: Object.freeze([...bindings.providers]),
					shellRoutes: Object.freeze([...bindings.shellRoutes]),
					...(bindings.host !== undefined && { host: bindings.host }),
					commit() {
						if (bindings.pin !== undefined) {
							throw invalidBootstrap();
						}

						bindings.pin = owner;
					}
				})
			);

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

	if (localRuntimeBindings(pi).pin !== undefined) {
		return;
	}

	const local = protocolAddress(pi.events);
	const available = collectProtocolReplies(pi.events, RUNTIME_CHANNEL, local, {
		type: 'get-builds'
	});
	const ids = new Set<string>();
	const roster = available.map((reply) => {
		sharedFeatureLevel(local, reply);

		if (
			reply.kind !== 'advertisement' ||
			!isBuildAdvertisement(reply.payload) ||
			ids.has(reply.payload.candidateId)
		) {
			throw invalidBootstrap();
		}

		ids.add(reply.payload.candidateId);

		return {
			identity: Object.freeze({
				major: reply.major,
				featureLevel: reply.featureLevel,
				buildId: reply.buildId,
				packageVersion: reply.packageVersion,
				extensionSource: reply.extensionSource
			}),
			candidateId: reply.payload.candidateId
		};
	});
	const selected = roster.toSorted((a, b) =>
		compareBuilds(b.identity, a.identity)
	)[0];

	if (selected === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	const handoff: { start?: BrokerStarter; isInvalid?: true } = {};
	const replies = collectProtocolReplies(pi.events, RUNTIME_CHANNEL, local, {
		type: 'start-broker',
		candidateId: selected.candidateId,
		owner: selected.identity,
		sessionId: inspectContext(context, 'acquire').sessionId,
		receive(identity: ProtocolIdentity, received: BrokerStarter) {
			if (
				handoff.start !== undefined ||
				!areProtocolIdentitiesEqual(identity, selected.identity)
			) {
				handoff.isInvalid = true;

				return;
			}

			handoff.start = received;
		}
	});

	if (
		handoff.isInvalid === true ||
		handoff.start === undefined ||
		replies.length > 0
	) {
		throw invalidBootstrap();
	}

	await handoff.start(context, roster);

	if (localRuntimeBindings(pi).pin === undefined) {
		throw invalidBootstrap();
	}
}

export function ensureSandboxService(pi: SandboxHost) {
	const pin = localRuntimeBindings(pi).pin;

	if (pin === undefined || !isPiBound(pi)) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	const service = discoverBroker(pi.events, pin);

	if (service === undefined) {
		throw new SandboxInitialisationError({ operation: 'discover' });
	}

	return service;
}
