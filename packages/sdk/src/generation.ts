import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import { acquireOptions, refuseProfile } from './acquire-options.js';
import { snapshotBackend, snapshotRecovery } from './backend-snapshot.js';
import { validateBackend, verifyGrantedPaths } from './backend-validation.js';
import {
	DEFAULT_CLEANUP_BUDGETS,
	resolveCleanupBudgets
} from './cleanup-budgets.js';
import { failedCloseReport, settleSandboxClose } from './cleanup-report.js';
import type { SandboxConfig } from './config.js';
import { selectProvider } from './config.js';
import { SandboxSession } from './context.js';
import type {
	RecoveryDescriptor,
	Sandbox,
	SandboxAcquireOptions,
	SandboxBackend,
	SandboxCloseReport,
	SandboxContext,
	SandboxCopy,
	SandboxCopySource,
	SandboxErrorInfo,
	SandboxNegotiation,
	SandboxOpenContext,
	SandboxOperation,
	SandboxOperationContext,
	SandboxOperationOptions,
	SandboxPolicy
} from './contracts.js';
import { resolveCredentialExclusions } from './credential-locations.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	isSandboxError,
	rehydrateSandboxError,
	SandboxCleanupError,
	SandboxInitialisationError,
	SandboxPermissionDeniedError,
	SandboxSessionClosingError,
	SandboxStartupError,
	StaleSandboxHandleError,
	UnconfirmedSandboxTerminationError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import type { SandboxLedgerEntry } from './escalation-ledger.js';
import type { EscalatedSandbox, EscalationPlan } from './escalation-plan.js';
import { describeRestrictions } from './escalation-plan.js';
import type { SandboxOwner } from './facade.js';
import { createSandbox } from './facade.js';
import type { Settlement } from './lifecycle.js';
import {
	observe,
	OperationRegistry,
	OperationScope,
	settleOperation
} from './lifecycle.js';
import { MutationQueue } from './mutation-queue.js';
import {
	createPassthroughProvider,
	passthroughProvider
} from './passthrough-provider.js';
import { requestedPathGrants, resolvePathGrants } from './path-grants.js';
import type { Profile } from './policy-model.js';
import {
	accessOrder,
	accessPolicySchema as policySchema,
	profileKey,
	unrestrictedPolicy
} from './policy-model.js';
import type { ProfileMode, ResolvedPath } from './profile-negotiation.js';
import { selectProfile } from './profile-negotiation.js';
import type {
	BrokerState,
	ConfiguredProviderV1,
	CopySourceIdentity,
	ProviderInfo,
	ProviderSelection,
	ProviderServiceV1,
	SandboxBackendStatus,
	SandboxStatus
} from './protocol.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { checkDemand } from './protocol-version.js';
import type { DiagnosticStore } from './provider-diagnostics.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import type { SaveReadRoots } from './read-root-persistence.js';
import { acquireOptionsSchema } from './request-schemas.js';
import { copySource, rethrowCopyError } from './sandbox-copy.js';
import { callable, checker } from './schemas.js';
import { isRecord, isRecovery, snapshotProviderInfo } from './validation.js';

export interface GenerationDependencies {
	readonly diagnostics?: DiagnosticStore;
	readonly appendLedger?: (entry: SandboxLedgerEntry) => void;
	readonly protocol?: ProtocolIdentity;
	readonly providers: (
		context: SandboxContext
	) => readonly ProviderServiceV1[] | Promise<readonly ProviderServiceV1[]>;
	readonly mode?: ProfileMode;
	readonly isEscalated?: boolean;
	readonly readConfig: (context: SandboxContext) => Promise<SandboxConfig>;
	/**
	The configured policy of the session that this generation copies from. A
	copy's own policy is usually stricter, so needs in a copy of a copy are
	checked against this policy.
	*/
	readonly copyLimit?: SandboxPolicy;
}
interface Prepared {
	readonly provider: ProviderServiceV1;
	readonly configured: ConfiguredProviderV1;
}
interface Disposable {
	readonly dispose: (context: SandboxOperationContext) => Promise<void>;
}
interface BackendSlot {
	readonly profile: Profile;
	readonly paths: readonly ResolvedPath[];
	state: SandboxBackendStatus['state'];
	opening:
		| Promise<Exclude<Settlement<SandboxBackend>, { kind: 'abandoned' }>>
		| undefined;
	backend: SandboxBackend | undefined;
	provided: SandboxBackend | undefined;
	candidate: unknown;
	recovery: RecoveryDescriptor;
	candidateRecovery: RecoveryDescriptor | undefined;
	hasRecovery: boolean;
	hasInvokedOpen: boolean;
	isOpenCleanupConfirmed: boolean;
	failure: SandboxErrorInfo | undefined;
	isUncertain: boolean;
	disposing: Promise<boolean> | undefined;
	disposalReport: SandboxCloseReport | undefined;
}

const isDisposable = checker(
	Type.Object({ dispose: callable<Disposable['dispose']>() })
);

export class SandboxGeneration {
	readonly #diagnostics: DiagnosticStore;
	#cleanup = DEFAULT_CLEANUP_BUDGETS;
	readonly #session: SandboxSession;
	readonly #dependencies: GenerationDependencies;
	readonly #lifetime = new AbortController();
	readonly #operations = new OperationRegistry();
	readonly #mutations = new MutationQueue();
	readonly #id = randomUUID();
	#state: BrokerState = 'initialising';
	#providerInfos: readonly ProviderInfo[] = [];
	#declarations: Promise<readonly ProviderServiceV1[]> | undefined;
	#selection: ProviderSelection | undefined;
	#allowsEscalation = true;
	#hostUserDataRoots: readonly string[] = Object.freeze([]);
	#resolveCredentialExclusions = resolveCredentialExclusions;
	#saveReadRoots: SaveReadRoots | undefined;
	#providerExtensionSource: string | undefined;
	#prepared: Promise<Prepared> | undefined;
	readonly #slots = new Map<string, BackendSlot>();
	#defaultProfile: Profile | undefined;
	readonly #children = new Set<SandboxCopy['close']>();
	#failure: SandboxErrorInfo | undefined;
	#closing: Promise<SandboxCloseReport> | undefined;
	readonly #cleanupFailures: SandboxErrorInfo[] = [];

	constructor(
		context: SandboxContext | SandboxSession,
		dependencies: GenerationDependencies
	) {
		this.#session =
			context instanceof SandboxSession ? context : new SandboxSession(context);
		this.#dependencies = dependencies;
		this.#diagnostics = dependencies.diagnostics ?? new ProviderDiagnostics();
	}

	#assertContext(context: SandboxContext, operation: SandboxOperation): void {
		this.#session.check(context, operation);
	}

	#assertNotClosing(operation: SandboxOperation): void {
		if (this.#state === 'closing' || this.#state === 'closed') {
			throw new SandboxSessionClosingError({ operation });
		}
	}

	#assertOpen(operation: SandboxOperation, slot?: BackendSlot): void {
		this.#assertNotClosing(operation);

		const failure = this.#failure ?? slot?.failure;

		if (failure !== undefined) {
			throw failure;
		}
	}

	#normalise(
		cause: unknown,
		operation: SandboxOperation,
		slot?: BackendSlot
	): SandboxErrorInfo {
		const recovery: RecoveryDescriptor =
			slot === undefined
				? { kind: 'none' }
				: slot.recovery.kind === 'none'
					? (slot.candidateRecovery ?? slot.recovery)
					: slot.recovery;
		const failure = isSandboxError(cause) ? cause : undefined;
		const extensionSource =
			failure?.extensionSource ?? this.#providerExtensionSource;
		const context = {
			operation,
			...(extensionSource !== undefined && { extensionSource }),
			...(failure?.providerId !== undefined && {
				providerId: failure.providerId
			}),
			...(this.#selection !== undefined && {
				providerId: this.#selection.providerId
			}),
			...(slot?.backend !== undefined && { backendId: slot.backend.id }),
			...(slot?.isOpenCleanupConfirmed !== true &&
				recovery.kind !== 'none' && { recovery })
		};

		if (failure !== undefined) {
			return rehydrateSandboxError(failure, { cause }, context);
		}

		return operation === 'open'
			? new SandboxStartupError(context, { cause })
			: new SandboxInitialisationError(context, { cause });
	}

	#fail(error: SandboxErrorInfo): void {
		this.#failure ??= error;

		if (this.#state !== 'closing' && this.#state !== 'closed') {
			this.#state = 'failed';
		}
	}

	#failSlot(slot: BackendSlot, error: SandboxErrorInfo): void {
		slot.failure ??= error;
		slot.state = 'failed';
	}

	#prepare(): Promise<Prepared> {
		if (this.#prepared !== undefined) {
			return this.#prepared;
		}

		const pending = Promise.withResolvers<Prepared>();

		this.#prepared = pending.promise;
		void observe(pending.promise);
		void this.#load(pending);

		return pending.promise;
	}

	async #readProviders(): Promise<readonly ProviderServiceV1[]> {
		const declarations = await this.#dependencies.providers(
			this.#session.context
		);
		const providers = Object.freeze(
			declarations.map((provider) =>
				Object.freeze({
					...snapshotProviderInfo(provider),
					...(provider.protocol !== undefined && {
						protocol: provider.protocol
					}),
					...(provider.prepare !== undefined && {
						prepare: provider.prepare.bind(provider)
					})
				})
			)
		);

		this.#providerInfos = Object.freeze(
			providers.map((provider) => snapshotProviderInfo(provider))
		);

		return providers;
	}

	#providers(): Promise<readonly ProviderServiceV1[]> {
		return (this.#declarations ??= this.#readProviders());
	}

	async #load(pending: PromiseWithResolvers<Prepared>): Promise<void> {
		try {
			const providers = await this.#providers();
			const config = await this.#dependencies.readConfig(this.#session.context);

			this.#allowsEscalation = config.allowEscalation ?? true;
			this.#cleanup = resolveCleanupBudgets(config.cleanup);
			this.#hostUserDataRoots =
				config.hostUserDataRoots ?? this.#hostUserDataRoots;
			this.#resolveCredentialExclusions =
				config.resolveCredentialExclusions ?? this.#resolveCredentialExclusions;
			this.#saveReadRoots = config.saveReadRoots;

			if (this.#lifetime.signal.aborted) {
				throw new SandboxSessionClosingError({ operation: 'configure' });
			}

			this.#selection = Object.freeze({
				providerId: config.selection.providerId,
				source: config.selection.source,
				policy: Object.freeze({ ...config.selection.policy }),
				...(config.selection.userShell !== undefined && {
					userShell: config.selection.userShell
				})
			});

			const provider = selectProvider(config, providers);
			const defaults = selectProfile({
				profiles: provider.profiles.open,
				limit: this.#selection.policy,
				mode: this.#dependencies.mode === 'copy' ? 'copy' : 'open'
			});

			this.#defaultProfile = defaults.ok ? defaults.profile : undefined;
			this.#providerExtensionSource = provider.protocol?.extensionSource;

			const local = this.#dependencies.protocol;
			const peer = provider.protocol;

			if (local !== undefined && peer !== undefined) {
				checkDemand(
					policySchema,
					this.#selection.policy,
					local,
					peer,
					'sandbox policy'
				);
			}

			const configured = config.configured ?? (await provider.prepare?.());

			if (configured === undefined) {
				throw new InvalidSandboxConfigError({
					operation: 'configure',
					providerId: provider.id
				});
			}

			if (this.#state === 'initialising') {
				this.#state = 'idle';
			}

			pending.resolve({ provider, configured });
		} catch (error_) {
			const error = this.#normalise(error_, 'configure');

			this.#fail(error);
			pending.reject(error);
		}
	}

	#slot(profile: Profile, paths: readonly ResolvedPath[]): BackendSlot {
		const key = JSON.stringify([
			profileKey(profile),
			paths.map(({ kind, path }) => [kind, path])
		]);
		const existing = this.#slots.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const slot: BackendSlot = {
			profile,
			paths,
			state: 'opening',
			opening: undefined,
			backend: undefined,
			provided: undefined,
			candidate: undefined,
			recovery: { kind: 'none' },
			candidateRecovery: undefined,
			hasRecovery: false,
			hasInvokedOpen: false,
			isOpenCleanupConfirmed: false,
			failure: undefined,
			isUncertain: false,
			disposalReport: undefined,
			disposing: undefined
		};

		this.#slots.set(key, slot);

		return slot;
	}

	#start(
		slot: BackendSlot
	): Promise<Exclude<Settlement<SandboxBackend>, { kind: 'abandoned' }>> {
		if (slot.opening !== undefined) {
			return slot.opening;
		}

		const pending = Promise.withResolvers<SandboxBackend>();

		slot.opening = observe(pending.promise);
		void this.#open(pending, slot);

		return slot.opening;
	}

	#reportRecovery(slot: BackendSlot, value: unknown): void {
		if (
			!isRecovery(value) ||
			(slot.recovery.kind === 'allocation' && value.kind === 'none')
		) {
			throw new InvalidSandboxDeclarationError({ operation: 'open' });
		}

		slot.recovery = snapshotRecovery(value);
		slot.hasRecovery = true;
	}

	async #allocate(
		scope: OperationScope,
		slot: BackendSlot
	): Promise<SandboxBackend> {
		const prepared = await this.#prepare();
		const local = this.#dependencies.protocol;
		const peer = prepared.provider.protocol;

		if (local !== undefined && peer !== undefined) {
			checkDemand(
				policySchema,
				slot.profile.policy,
				local,
				peer,
				'sandbox opening'
			);
		}

		const paths = requestedPathGrants(slot.paths);
		const isConstrained = prepared.provider.id !== passthroughProvider.id;
		const canAccessUserData = slot.profile.policy.hostUserData !== 'denied';
		const hostUserDataRoots =
			isConstrained && canAccessUserData ? this.#hostUserDataRoots : undefined;
		const credentialExclusions =
			isConstrained &&
			(canAccessUserData ||
				slot.paths.some(({ location }) => location === 'host-user-data'))
				? await this.#resolveCredentialExclusions()
				: undefined;

		scope.check();
		scope.setCleanupBudgets(this.#cleanup);
		slot.hasInvokedOpen = true;

		let isOpening = true;
		let candidate: unknown;

		try {
			candidate = await prepared.configured.open(
				{
					generationId: this.#id,
					sessionId: this.#session.sessionId,
					hostWorkspace: this.#session.workspace,
					profile: slot.profile,
					...(hostUserDataRoots !== undefined && { hostUserDataRoots }),
					...(credentialExclusions !== undefined && { credentialExclusions }),
					...(paths !== undefined && { paths })
				},
				{
					...scope.context,
					reportRecovery: (recovery) => {
						if (!isOpening || slot.isOpenCleanupConfirmed) {
							throw new InvalidSandboxDeclarationError({ operation: 'open' });
						}

						this.#reportRecovery(slot, recovery);
					},
					confirmCleanup: () => {
						if (!isOpening) {
							throw new InvalidSandboxDeclarationError({ operation: 'open' });
						}

						slot.isOpenCleanupConfirmed = true;
					}
				}
			);
		} finally {
			isOpening = false;
		}

		slot.candidate = candidate;

		if (isRecord(candidate) && isRecovery(candidate['recovery'])) {
			slot.candidateRecovery = snapshotRecovery(candidate['recovery']);

			if (!slot.hasRecovery) {
				slot.recovery = snapshotRecovery(candidate['recovery']);
			}
		}

		if (slot.isOpenCleanupConfirmed) {
			slot.isOpenCleanupConfirmed = false;

			throw new InvalidSandboxDeclarationError({ operation: 'open' });
		}

		if (
			scope.reason !== undefined ||
			this.#state === 'closing' ||
			this.#state === 'closed'
		) {
			const isDisposed = await this.#dispose(slot);

			throw scope.cancellationError(isDisposed ? 'confirmed' : 'unknown');
		}

		const provided = validateBackend(
			candidate,
			prepared.provider,
			slot.profile,
			this.#dependencies.mode ?? 'open',
			hostUserDataRoots
		);

		await verifyGrantedPaths(
			provided,
			slot.paths,
			scope.context,
			prepared.provider,
			this.#dependencies.isEscalated
		);
		scope.check();

		const backend = snapshotBackend(provided);

		if (
			(backend.recovery.kind === 'allocation' && !slot.hasRecovery) ||
			!isSameRecovery(slot.recovery, backend.recovery)
		) {
			throw new InvalidSandboxDeclarationError({
				operation: 'open',
				providerId: prepared.provider.id
			});
		}

		slot.recovery = snapshotRecovery(backend.recovery);
		slot.candidate = backend;
		slot.backend = backend;
		slot.provided = provided;
		slot.state = 'ready';

		return backend;
	}

	async #open(
		pending: PromiseWithResolvers<SandboxBackend>,
		slot: BackendSlot
	): Promise<void> {
		const scope = new OperationScope(
			{ operation: 'open' },
			this.#lifetime.signal,
			{},
			60_000
		);

		scope.setDiagnosticReporter((identity, diagnostic) => {
			this.#diagnostics.record(
				{
					...identity,
					...(this.#selection !== undefined && {
						providerId: this.#selection.providerId
					})
				},
				diagnostic
			);
		});

		try {
			const allocation = Promise.try(() => this.#allocate(scope, slot));
			const completion = observe(allocation);
			const first = await Promise.race([completion, scope.whenCancelled()]);

			if (!slot.hasInvokedOpen && first.kind === 'cancelled') {
				throw scope.cancellationError('not-started');
			}

			const result =
				first.kind === 'cancelled'
					? await settleOperation(scope, allocation)
					: first;

			if (result.kind === 'abandoned') {
				slot.isUncertain = true;

				throw new UnconfirmedSandboxTerminationError({
					operation: 'open',
					...(scope.reason !== undefined && { reason: scope.reason }),
					...(slot.recovery.kind !== 'none' && { recovery: slot.recovery })
				});
			}

			if (result.kind === 'rejected') {
				if (
					slot.candidate === undefined &&
					slot.recovery.kind === 'allocation'
				) {
					slot.isUncertain = !slot.isOpenCleanupConfirmed;
				}

				throw result.error;
			}

			pending.resolve(result.value);
		} catch (error_) {
			let error = this.#normalise(error_, 'open', slot);

			this.#failSlot(slot, error);

			if (slot.candidate !== undefined) {
				const isDisposed = await this.#dispose(slot);

				if (isDisposed && !slot.isUncertain) {
					slot.isOpenCleanupConfirmed = true;
					error = this.#normalise(error_, 'open', slot);
					slot.failure = error;
				}

				if (
					!isDisposed &&
					slot.disposalReport?.failures.some(
						(failure) =>
							isSandboxError(failure, SandboxCleanupError) &&
							failure.closeReport !== undefined
					) === true &&
					this.#dependencies.mode !== 'copy'
				) {
					error = new SandboxCleanupError(
						{
							operation: 'dispose',
							...(error.providerId !== undefined && {
								providerId: error.providerId
							}),
							...(error.backendId !== undefined && {
								backendId: error.backendId
							}),
							closeReport: this.#closeReport(
								[slot],
								slot.disposalReport.failures
							)
						},
						{ cause: error }
					);
					slot.failure = error;
				}
			}

			pending.reject(error);
		} finally {
			scope.dispose();
		}
	}

	#owner(
		context: SandboxContext,
		slot: BackendSlot,
		backend: SandboxBackend
	): SandboxOwner {
		const selection = this.#selection;

		if (selection === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		return {
			identity: {
				providerId: selection.providerId,
				backendId: backend.id,
				recovery: slot.recovery
			},
			generationId: this.#id,
			cleanup: this.#cleanup,
			reportWarning: this.#diagnostics.record.bind(this.#diagnostics),
			backend,
			lifetime: this.#lifetime.signal,
			operations: this.#operations,
			mutations: this.#mutations,
			assertLive: (operation) => {
				this.#assertContext(context, operation);
				this.#assertOpen(operation, slot);
			},
			markUnhealthy: (failure) => {
				this.#failSlot(slot, failure);
			},
			copy: (options) =>
				this.copy(
					context,
					{
						kind: 'sandbox',
						providerId: selection.providerId,
						generationId: this.#id,
						backendId: backend.id
					},
					options
				)
		};
	}

	#dispose(slot: BackendSlot): Promise<boolean> {
		if (slot.disposing !== undefined) {
			return slot.disposing;
		}

		const candidate = slot.candidate;

		if (candidate === undefined) {
			return Promise.resolve(
				!slot.isUncertain &&
					(slot.isOpenCleanupConfirmed || slot.recovery.kind === 'none')
			);
		}

		const pending = Promise.withResolvers<boolean>();

		slot.disposing = pending.promise;
		void this.#release(candidate, pending, slot);

		return pending.promise;
	}

	async #release(
		candidate: unknown,
		pending: PromiseWithResolvers<boolean>,
		slot: BackendSlot
	): Promise<void> {
		const scope = new OperationScope(
			{ operation: 'dispose' },
			new AbortController().signal,
			{},
			this.#cleanup.disposalTimeoutMs,
			this.#cleanup
		);

		scope.setDiagnosticReporter((identity, diagnostic) => {
			this.#diagnostics.record(
				{
					...identity,
					...(this.#selection !== undefined && {
						providerId: this.#selection.providerId
					}),
					...(slot.backend !== undefined && { backendId: slot.backend.id })
				},
				diagnostic
			);
		});

		try {
			if (!isDisposable(candidate)) {
				throw new SandboxCleanupError({ operation: 'dispose' });
			}

			const result = await Promise.race([
				observe(Promise.try(() => candidate.dispose(scope.context))),
				scope.whenCancelled()
			]);

			scope.check('unknown');

			if (result.kind === 'rejected') {
				throw result.error;
			}

			if (result.kind === 'cancelled') {
				throw scope.cancellationError('unknown');
			}

			pending.resolve(true);
		} catch (error) {
			const failure = isSandboxError(error, SandboxCleanupError)
				? error
				: new SandboxCleanupError(
						{
							operation: 'dispose',
							...(slot.recovery.kind !== 'none' && { recovery: slot.recovery })
						},
						{ cause: error }
					);

			slot.disposalReport = failedCloseReport(failure);
			this.#cleanupFailures.push(...slot.disposalReport.failures);
			pending.resolve(false);
		} finally {
			scope.dispose();
		}
	}

	#closeReport(
		unconfirmed: readonly BackendSlot[],
		failures: readonly SandboxErrorInfo[]
	): SandboxCloseReport {
		const recoveries = Object.freeze(
			unconfirmed
				.flatMap((slot) => [
					...(slot.recovery.kind === 'allocation' ? [slot.recovery] : []),
					...(slot.candidateRecovery?.kind === 'allocation' &&
					!isSameRecovery(slot.recovery, slot.candidateRecovery)
						? [slot.candidateRecovery]
						: []),
					...(slot.disposalReport?.recoveries ?? [])
				])
				.filter(
					(recovery, index, all) =>
						all.findIndex((other) => isSameRecovery(recovery, other)) === index
				)
		);

		return Object.freeze({
			confirmed: unconfirmed.length === 0 && failures.length === 0,
			recoveries,
			failures: Object.freeze([...failures])
		});
	}

	async #finishClose(
		pending: PromiseWithResolvers<SandboxCloseReport>
	): Promise<void> {
		const slots = this.#slots.values().toArray();

		try {
			await Promise.all(
				slots.flatMap((slot) =>
					slot.opening === undefined ? [] : [slot.opening]
				)
			);

			const copies = await Promise.all(
				this.#children.values().map((close) => settleSandboxClose(close))
			);

			await this.#operations.drain();

			const disposals = await Promise.all(
				slots.map((slot) => this.#dispose(slot))
			);
			const unconfirmed = slots.filter(
				(slot, index) => disposals[index] !== true || slot.isUncertain
			);
			const failures = [
				...slots.flatMap((slot) =>
					slot.isUncertain && slot.failure !== undefined ? [slot.failure] : []
				),
				...this.#cleanupFailures
			];

			this.#state = 'closed';

			const report = this.#closeReport(unconfirmed, failures);

			const reports = [report, ...copies];
			const recoveries = reports.flatMap((child) => child.recoveries);
			const cleanupFailures = reports.flatMap((child) => child.failures);

			pending.resolve(
				Object.freeze({
					confirmed: reports.every((child) => child.confirmed),
					recoveries: Object.freeze(recoveries),
					failures: Object.freeze(cleanupFailures)
				})
			);
		} catch (error) {
			this.#state = 'closed';
			pending.resolve(
				this.#closeReport(slots, [
					new SandboxCleanupError({ operation: 'dispose' }, { cause: error })
				])
			);
		}
	}

	#checkDemand(
		provider: ProviderServiceV1,
		options: SandboxAcquireOptions
	): void {
		const local = this.#dependencies.protocol;
		const peer = provider.protocol;

		if (local !== undefined && peer !== undefined) {
			checkDemand(
				acquireOptionsSchema,
				options,
				local,
				peer,
				'sandbox acquisition'
			);
		}
	}

	async #negotiate(
		provider: ProviderServiceV1,
		options: SandboxAcquireOptions,
		profiles = provider.profiles.open,
		mode: ProfileMode = this.#dependencies.mode === 'copy' ? 'copy' : 'open',
		limit = this.#selection?.policy
	) {
		if (limit === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		this.#checkDemand(provider, options);

		const paths = await resolvePathGrants(
			this.#session.workspace,
			options.access?.paths,
			this.#resolveCredentialExclusions
		);
		const result = selectProfile({
			profiles,
			limit,
			requirements: options,
			mode,
			paths,
			hostUserDataRoots: this.#hostUserDataRoots,
			isUnrestrictedHost: provider.id === passthroughProvider.id
		});

		if (!result.ok) {
			refuseProfile(result.detail, {
				operation: 'acquire',
				providerId: provider.id
			});
		}

		return { profile: result.profile, paths };
	}

	#copyOrigin(
		source: CopySourceIdentity,
		providerId: string
	): SandboxCopySource {
		if (source.kind === 'host') {
			return source;
		}

		const slots = this.#slots
			.values()
			.filter((slot) => slot.backend?.id === source.backendId)
			.toArray();
		const [slot] = slots;

		if (
			source.generationId !== this.#id ||
			source.providerId !== providerId ||
			slots.length !== 1 ||
			slot?.state !== 'ready' ||
			slot.provided === undefined
		) {
			throw new StaleSandboxHandleError({ operation: 'acquire' });
		}

		return { kind: 'backend', backend: slot.provided };
	}

	async #hostEscalation(
		requirements: SandboxAcquireOptions,
		paths: readonly ResolvedPath[]
	): Promise<Prepared & { readonly profile: Profile }> {
		const provider = await createPassthroughProvider(this.#session.workspace);
		const choice = selectProfile({
			profiles: provider.profiles.open,
			limit: unrestrictedPolicy,
			isUnrestrictedHost: true,
			requirements,
			paths
		});

		if (!choice.ok) {
			refuseProfile(choice.detail, {
				operation: 'acquire',
				providerId: provider.id
			});
		}

		const configured = await provider.prepare();

		return { provider, configured, profile: choice.profile };
	}

	async #openEscalation(
		context: SandboxContext,
		chosen: Prepared & { readonly profile: Profile },
		paths: readonly ResolvedPath[],
		options: SandboxOperationOptions = {}
	): Promise<EscalatedSandbox> {
		const { provider, configured, profile } = chosen;
		const generation = new SandboxGeneration(this.#session, {
			...this.#dependencies,
			isEscalated: true,
			providers: () => [
				{
					...provider,
					profiles: { ...provider.profiles, open: [profile] },
					prepare: () => configured
				}
			],
			readConfig: () =>
				Promise.resolve({
					selection: {
						source: 'extension',
						providerId: provider.id,
						policy: profile.policy
					},
					hostUserDataRoots: this.#hostUserDataRoots,
					resolveCredentialExclusions: this.#resolveCredentialExclusions,
					cleanup: this.#cleanup
				})
		});
		const close = async () => {
			const report = await generation.close();

			if (report.confirmed) {
				this.#children.delete(close);
			}

			return report;
		};

		this.#children.add(close);

		try {
			const sandbox = await generation.#acquireProfile(
				context,
				profile,
				paths,
				options
			);

			return Object.freeze({ sandbox, close });
		} catch (error) {
			return await rethrowCopyError(error, close, {
				operation: 'dispose',
				providerId: provider.id
			});
		}
	}

	async #acquireProfile(
		context: SandboxContext,
		profile: Profile,
		paths: readonly ResolvedPath[],
		options: SandboxOperationOptions
	): Promise<Sandbox> {
		const scope = new OperationScope(
			{ operation: 'acquire' },
			this.#lifetime.signal,
			options,
			60_000
		);

		try {
			scope.check();

			return await this.#readySandbox(context, profile, paths, scope);
		} finally {
			scope.dispose();
		}
	}

	async #readySandbox(
		context: SandboxContext,
		profile: Profile,
		paths: readonly ResolvedPath[],
		scope: OperationScope
	): Promise<Sandbox> {
		const slot = this.#slot(profile, paths);
		const result = await Promise.race([
			this.#start(slot),
			scope.whenCancelled()
		]);

		if (result.kind === 'cancelled') {
			throw scope.cancellationError('not-started');
		}

		scope.check();

		if (result.kind === 'rejected') {
			throw result.error;
		}

		this.#assertContext(context, 'acquire');
		this.#assertOpen('acquire', slot);

		return createSandbox(this.#owner(context, slot, result.value));
	}

	async #negotiateCopy(
		{ configured, provider }: Prepared,
		source: CopySourceIdentity,
		options: SandboxAcquireOptions
	) {
		const copy = configured.copy;
		const identity = {
			operation: 'acquire' as const,
			providerId: provider.id
		};

		this.#checkDemand(provider, options);

		if (typeof copy !== 'function') {
			throw new UnsupportedSandboxCapabilityError({
				...identity,
				detail: { kind: 'copy-unavailable' }
			});
		}

		const origin = this.#copyOrigin(source, provider.id);
		const selection = this.#selection;

		if (selection === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		const limit = this.#dependencies.copyLimit ?? selection.policy;
		const { profile } = await this.#negotiate(
			provider,
			options,
			provider.profiles.copy,
			'copy',
			limit
		);

		return { copy, origin, profile, limit };
	}

	async initialize(): Promise<void> {
		this.#assertOpen('configure');
		await this.#prepare();
	}

	async planEscalation(
		context: SandboxContext,
		options: SandboxAcquireOptions
	): Promise<EscalationPlan> {
		const assertCurrent = (actual: SandboxContext) => {
			this.#assertContext(actual, 'exec');
			this.#assertOpen('exec');
		};

		assertCurrent(context);

		const prepared = await this.#prepare();

		if (!this.#allowsEscalation) {
			throw new SandboxPermissionDeniedError({
				operation: 'exec',
				detail: { kind: 'request', field: 'allowEscalation', value: false }
			});
		}

		const limit = this.#selection?.policy;

		if (limit === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		this.#checkDemand(prepared.provider, options);

		const paths = await resolvePathGrants(
			this.#session.workspace,
			options.access?.paths,
			this.#resolveCredentialExclusions
		);
		const choice = selectProfile({
			profiles: prepared.provider.profiles.open,
			limit,
			requirements: options,
			paths,
			hostUserDataRoots: this.#hostUserDataRoots,
			isEscalated: true
		});
		const isHost =
			!choice.ok || prepared.provider.id === passthroughProvider.id;
		const destination = isHost
			? await this.#hostEscalation(options, paths)
			: { ...prepared, profile: choice.profile };

		assertCurrent(context);

		const policy = destination.profile.policy;
		const grants = requestedPathGrants(paths);
		const eligibleReads = isHost
			? []
			: paths.filter(
					(entry) =>
						entry.kind === 'read' &&
						entry.location !== 'workspace' &&
						entry.isCredential !== true
				);
		const hasAccessProperties = accessOrder.some(
			(property) => options.access?.[property] !== undefined
		);
		const readApprovalPaths = Object.freeze(
			eligibleReads.map((entry) => entry.path)
		);
		const saveReadRoots = this.#saveReadRoots;
		const userDataReads = eligibleReads
			.filter(({ location }) => location === 'host-user-data')
			.map(({ path }) => path);
		const pathsToSave = Object.freeze(userDataReads);
		let isUsed = false;

		return Object.freeze<EscalationPlan>({
			destination: isHost
				? Object.freeze({ kind: 'host', policy, effectiveRestrictions: 'none' })
				: Object.freeze({
						kind: 'provider',
						providerId: destination.provider.id,
						policy,
						effectiveRestrictions: describeRestrictions(policy, {
							...(grants !== undefined && { paths: grants }),
							hostUserDataRoots: this.#hostUserDataRoots
						})
					}),
			label: destination.provider.label,
			...(grants !== undefined && { paths: grants }),
			...(eligibleReads.length > 0 && {
				readApproval: Object.freeze({
					paths: readApprovalPaths,
					coversRequest:
						!hasAccessProperties && eligibleReads.length === paths.length,
					...(saveReadRoots !== undefined &&
						pathsToSave.length > 0 && {
							persistence: Object.freeze({
								paths: pathsToSave,
								save: (signal: AbortSignal) =>
									saveReadRoots(pathsToSave, this.#session.workspace, signal)
							})
						})
				})
			}),
			assertCurrent,
			open: async (actual, processOptions) => {
				assertCurrent(actual);
				processOptions?.signal?.throwIfAborted();

				if (isUsed) {
					throw new InvalidSandboxRequestError({ operation: 'exec' });
				}

				isUsed = true;

				return await this.#openEscalation(
					actual,
					destination,
					paths,
					processOptions
				);
			}
		});
	}

	async acquire(
		context: SandboxContext,
		input?: SandboxAcquireOptions
	): Promise<Sandbox> {
		this.#assertContext(context, 'acquire');
		this.#assertOpen('acquire');

		const options = acquireOptions(input);
		const scope = new OperationScope(
			{ operation: 'acquire' },
			this.#lifetime.signal,
			options,
			60_000
		);

		try {
			scope.check();

			const prepared = await Promise.race([
				observe(this.#prepare()),
				scope.whenCancelled()
			]);

			if (prepared.kind === 'cancelled') {
				throw scope.cancellationError('not-started');
			}

			scope.check();

			if (prepared.kind === 'rejected') {
				throw prepared.error;
			}

			const { profile, paths } = await this.#negotiate(
				prepared.value.provider,
				options
			);

			scope.check();

			return await this.#readySandbox(context, profile, paths, scope);
		} finally {
			scope.dispose();
		}
	}

	async copy(
		context: SandboxContext,
		input: CopySourceIdentity,
		settings?: SandboxAcquireOptions
	): Promise<SandboxCopy> {
		this.#assertContext(context, 'acquire');
		this.#assertOpen('acquire');

		const source = copySource(input);
		const options = acquireOptions(settings);
		const scope = new OperationScope(
			{ operation: 'acquire' },
			this.#lifetime.signal,
			options,
			60_000,
			this.#cleanup
		);

		try {
			scope.check();

			const ready = await Promise.race([
				observe(this.#prepare()),
				scope.whenCancelled()
			]);

			if (ready.kind === 'cancelled') {
				throw scope.cancellationError('not-started');
			}

			if (ready.kind === 'rejected') {
				throw ready.error;
			}

			scope.check();

			const { provider, configured } = ready.value;
			const { copy, origin, profile, limit } = await this.#negotiateCopy(
				ready.value,
				source,
				options
			);
			const policy = profile.policy;

			scope.check();

			const copier = (
				request: Parameters<typeof copy>[0],
				opening: SandboxOpenContext
			) => copy.call(configured, request, opening);
			const generation = new SandboxGeneration(this.#session, {
				diagnostics: this.#diagnostics,
				...(this.#dependencies.protocol !== undefined && {
					protocol: this.#dependencies.protocol
				}),
				copyLimit: limit,
				mode: 'copy',
				providers: () => [
					{
						...provider,
						profiles: { ...provider.profiles, open: [profile] },
						prepare: () => ({
							open: (request, opening) =>
								copier({ ...request, source: origin }, opening),
							copy: copier
						})
					}
				],
				readConfig: () =>
					Promise.resolve({
						selection: { source: 'extension', providerId: provider.id, policy },
						hostUserDataRoots: this.#hostUserDataRoots,
						resolveCredentialExclusions: this.#resolveCredentialExclusions,
						cleanup: this.#cleanup
					})
			});

			const close = async () => {
				options.signal?.removeEventListener('abort', cancel);

				const report = await generation.close();

				if (report.confirmed) {
					this.#children.delete(close);
				}

				return report;
			};

			const cancel = () => {
				void close();
			};

			this.#children.add(close);
			options.signal?.addEventListener('abort', cancel, { once: true });

			try {
				const {
					signal: _signal,
					timeoutMs: _timeout,
					...requirements
				} = options;
				const sandbox = await generation.acquire(context, {
					...requirements,
					signal: scope.context.signal
				});

				scope.check();

				return Object.freeze({ sandbox, close });
			} catch (error) {
				return await rethrowCopyError(error, close, {
					operation: 'dispose',
					providerId: provider.id
				});
			}
		} finally {
			scope.dispose();
		}
	}

	async negotiate(
		context: SandboxContext,
		input?: SandboxAcquireOptions
	): Promise<SandboxNegotiation> {
		this.#assertContext(context, 'acquire');
		this.#assertNotClosing('acquire');

		const options = acquireOptions(input);

		try {
			this.#assertOpen('acquire');

			const prepared = await this.#prepare();

			const { profile } = await this.#negotiate(prepared.provider, options);

			return Object.freeze({ ok: true, profile });
		} catch (error) {
			if (!isSandboxError(error)) {
				throw error;
			}

			return Object.freeze({ ok: false, error });
		}
	}

	async negotiateCopy(
		context: SandboxContext,
		input: CopySourceIdentity,
		requirements?: SandboxAcquireOptions
	): Promise<SandboxNegotiation> {
		this.#assertContext(context, 'acquire');
		this.#assertNotClosing('acquire');

		const source = copySource(input);
		const options = acquireOptions(requirements);

		try {
			this.#assertOpen('acquire');

			const prepared = await this.#prepare();
			const { profile } = await this.#negotiateCopy(prepared, source, options);

			return Object.freeze({ ok: true, profile });
		} catch (error) {
			if (!isSandboxError(error)) {
				throw error;
			}

			return Object.freeze({ ok: false, error });
		}
	}

	async status(): Promise<SandboxStatus> {
		if (this.#state !== 'closing' && this.#state !== 'closed') {
			await observe(this.#prepare());
		}

		const defaultKey =
			this.#defaultProfile === undefined
				? undefined
				: profileKey(this.#defaultProfile);
		const personal = this.#slots
			.values()
			.find(
				(slot) =>
					slot.paths.length === 0 && profileKey(slot.profile) === defaultKey
			);
		const backend = personal?.backend;
		const failure = this.#failure ?? personal?.failure;
		const backends = this.#slots
			.values()
			.map((slot): SandboxBackendStatus =>
				Object.freeze({
					policy: slot.profile.policy,
					state: slot.state,
					...(slot.backend !== undefined && {
						backendId: slot.backend.id,
						effectivePolicy: slot.backend.profile.policy
					})
				})
			)
			.toArray();
		const diagnostics = this.#diagnostics.snapshot();
		const providerId =
			this.#selection?.providerId ??
			(failure?.name === 'SandboxProviderUnavailableError'
				? failure.providerId
				: undefined);
		const provider = this.#providerInfos.find(
			(entry) => entry.id === providerId
		);

		return Object.freeze({
			...(provider !== undefined && { providerLabel: provider.label }),
			...(diagnostics.entries.length > 0 && {
				diagnostics: diagnostics.entries
			}),
			...(diagnostics.dropped > 0 && {
				diagnosticsDropped: diagnostics.dropped
			}),
			generationId: this.#id,
			state:
				personal !== undefined && this.#state === 'idle'
					? personal.state
					: this.#state,
			...(this.#selection !== undefined && { selection: this.#selection }),
			...(backends.length > 0 && { backends: Object.freeze(backends) }),
			...(backend !== undefined && {
				backendId: backend.id,
				workspace: backend.workspace,
				profile: backend.profile,
				policyDescription: backend.policyDescription
			}),
			...(failure !== undefined && { failure }),
			...(this.#closing !== undefined &&
				this.#state === 'closed' && { closeReport: await this.#closing })
		});
	}

	async providers(): Promise<readonly ProviderInfo[]> {
		this.#assertNotClosing('discover');
		await this.#providers();

		return this.#providerInfos;
	}

	close(): Promise<SandboxCloseReport> {
		if (this.#closing !== undefined) {
			return this.#closing;
		}

		this.#state = 'closing';

		const pending = Promise.withResolvers<SandboxCloseReport>();

		this.#closing = pending.promise;
		this.#lifetime.abort('shutdown');
		void this.#finishClose(pending);

		return pending.promise;
	}
}

function isSameRecovery(
	left: RecoveryDescriptor,
	right: RecoveryDescriptor
): boolean {
	return left.kind === 'none' || right.kind === 'none'
		? left.kind === right.kind
		: left.id === right.id &&
				left.instructions === right.instructions &&
				left.lease === right.lease;
}
