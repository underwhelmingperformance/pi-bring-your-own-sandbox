import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import { acquireOptions, checkRequirements } from './acquire-options.js';
import { snapshotBackend, snapshotRecovery } from './backend-snapshot.js';
import { validateBackend } from './backend-validation.js';
import {
	DEFAULT_CLEANUP_BUDGETS,
	resolveCleanupBudgets
} from './cleanup-budgets.js';
import type { SandboxConfig } from './config.js';
import { selectProvider } from './config.js';
import type { SessionIdentity } from './context.js';
import { inspectContext } from './context.js';
import type {
	RecoveryDescriptor,
	Sandbox,
	SandboxAcquireOptions,
	SandboxBackend,
	SandboxCloseReport,
	SandboxContext,
	SandboxErrorInfo,
	SandboxOperation,
	SandboxOperationContext,
	SandboxPolicy
} from './contracts.js';
import {
	InvalidSandboxDeclarationError,
	isSandboxError,
	rehydrateSandboxError,
	SandboxCleanupError,
	SandboxInitialisationError,
	SandboxSessionClosingError,
	SandboxStartupError,
	StaleSandboxHandleError,
	UnconfirmedSandboxTerminationError
} from './errors.js';
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
	checkDeclaredCapabilities,
	policyKey,
	resolvePolicy
} from './negotiation.js';
import type {
	BrokerState,
	ConfiguredProviderV1,
	ProviderInfo,
	ProviderSelection,
	ProviderServiceV1,
	SandboxBackendStatus,
	SandboxStatus
} from './protocol.js';
import { ProviderDiagnostics } from './provider-diagnostics.js';
import { callable, checker } from './schemas.js';
import { isRecord, isRecovery, snapshotProviderInfo } from './validation.js';

export interface GenerationDependencies {
	readonly providers: () => readonly ProviderServiceV1[];
	readonly readConfig: (context: SessionIdentity) => Promise<SandboxConfig>;
}
interface Prepared {
	readonly provider: ProviderServiceV1;
	readonly configured: ConfiguredProviderV1;
}
interface Disposable {
	readonly dispose: (context: SandboxOperationContext) => Promise<void>;
}
interface BackendSlot {
	readonly policy: SandboxPolicy;
	state: SandboxBackendStatus['state'];
	opening:
		| Promise<Exclude<Settlement<SandboxBackend>, { kind: 'abandoned' }>>
		| undefined;
	backend: SandboxBackend | undefined;
	candidate: unknown;
	recovery: RecoveryDescriptor;
	candidateRecovery: RecoveryDescriptor | undefined;
	hasRecovery: boolean;
	hasInvokedOpen: boolean;
	isOpenCleanupConfirmed: boolean;
	failure: SandboxErrorInfo | undefined;
	isUncertain: boolean;
	disposing: Promise<boolean> | undefined;
}

const isDisposable = checker(
	Type.Object({ dispose: callable<Disposable['dispose']>() })
);

export class SandboxGeneration {
	readonly #diagnostics = new ProviderDiagnostics();
	#cleanup = DEFAULT_CLEANUP_BUDGETS;
	readonly #context: SandboxContext;
	readonly #session: SessionIdentity;
	readonly #dependencies: GenerationDependencies;
	readonly #lifetime = new AbortController();
	readonly #operations = new OperationRegistry();
	readonly #mutations = new MutationQueue();
	readonly #id = randomUUID();
	#state: BrokerState = 'initialising';
	#providerInfos: readonly ProviderInfo[] = [];
	#selection: ProviderSelection | undefined;
	#configurationSource: 'personal' | undefined;
	#prepared: Promise<Prepared> | undefined;
	readonly #slots = new Map<string, BackendSlot>();
	#failure: SandboxErrorInfo | undefined;
	#closing: Promise<SandboxCloseReport> | undefined;
	readonly #cleanupFailures: SandboxErrorInfo[] = [];

	constructor(context: SandboxContext, dependencies: GenerationDependencies) {
		this.#context = context;
		this.#session = inspectContext(context, 'acquire');
		this.#dependencies = dependencies;
	}

	#assertContext(context: SandboxContext, operation: SandboxOperation): void {
		const actual = inspectContext(context, operation);
		const original = inspectContext(this.#context, operation);

		if (
			actual.sessionId !== this.#session.sessionId ||
			actual.workspace !== this.#session.workspace ||
			original.sessionId !== this.#session.sessionId ||
			original.workspace !== this.#session.workspace
		) {
			throw new StaleSandboxHandleError({ operation });
		}
	}

	#assertOpen(operation: SandboxOperation, slot?: BackendSlot): void {
		if (this.#state === 'closing' || this.#state === 'closed') {
			throw new SandboxSessionClosingError({ operation });
		}

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
		const context = {
			operation,
			...(this.#selection !== undefined &&
				this.#selection.source !== 'default' && {
					configurationSource: this.#selection.source
				}),
			...(this.#configurationSource !== undefined && {
				configurationSource: this.#configurationSource
			}),
			...(isSandboxError(cause) &&
				cause.configurationSource !== undefined && {
					configurationSource: cause.configurationSource
				}),
			...(this.#selection !== undefined && {
				providerId: this.#selection.providerId
			}),
			...(slot?.backend !== undefined && { backendId: slot.backend.id }),
			...(slot?.isOpenCleanupConfirmed !== true &&
				recovery.kind !== 'none' && { recovery })
		};

		if (isSandboxError(cause)) {
			return rehydrateSandboxError(cause, { cause }, context);
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

	async #load(pending: PromiseWithResolvers<Prepared>): Promise<void> {
		try {
			const providers = Object.freeze(
				this.#dependencies.providers().map((provider) =>
					Object.freeze({
						...snapshotProviderInfo(provider),
						configure: provider.configure.bind(provider)
					})
				)
			);

			this.#providerInfos = Object.freeze(
				providers.map((provider) => snapshotProviderInfo(provider))
			);

			const config = await this.#dependencies.readConfig(this.#session);

			this.#cleanup = resolveCleanupBudgets(config.cleanup);

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

			this.#configurationSource = config.providerConfigSource;

			const configured = provider.configure(config.providerConfig);

			this.#configurationSource = undefined;

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

	#slot(policy: SandboxPolicy): BackendSlot {
		const key = policyKey(policy);
		const existing = this.#slots.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const slot: BackendSlot = {
			policy,
			state: 'opening',
			opening: undefined,
			backend: undefined,
			candidate: undefined,
			recovery: { kind: 'none' },
			candidateRecovery: undefined,
			hasRecovery: false,
			hasInvokedOpen: false,
			isOpenCleanupConfirmed: false,
			failure: undefined,
			isUncertain: false,
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
					policy: slot.policy
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

		if (isRecord(candidate) && isRecovery(candidate.recovery)) {
			slot.candidateRecovery = snapshotRecovery(candidate.recovery);

			if (!slot.hasRecovery) {
				slot.recovery = snapshotRecovery(candidate.recovery);
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

		const backend = snapshotBackend(
			validateBackend(candidate, prepared.provider, slot.policy)
		);

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
			reportDiagnostic: this.#diagnostics.record.bind(this.#diagnostics),
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
			}
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

			if (result.kind !== 'resolved') {
				throw new SandboxCleanupError(
					{
						operation: 'dispose',
						...(slot.recovery.kind !== 'none' && { recovery: slot.recovery })
					},
					{
						cause:
							result.kind === 'rejected'
								? result.error
								: scope.cancellationError('unknown')
					}
				);
			}

			pending.resolve(true);
		} catch (error) {
			this.#cleanupFailures.push(
				new SandboxCleanupError(
					{
						operation: 'dispose',
						...(slot.recovery.kind !== 'none' && { recovery: slot.recovery })
					},
					{ cause: error }
				)
			);
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
			unconfirmed.flatMap((slot) => [
				...(slot.recovery.kind === 'allocation' ? [slot.recovery] : []),
				...(slot.candidateRecovery?.kind === 'allocation' &&
				!isSameRecovery(slot.recovery, slot.candidateRecovery)
					? [slot.candidateRecovery]
					: [])
			])
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
			pending.resolve(this.#closeReport(unconfirmed, failures));
		} catch (error) {
			this.#state = 'closed';
			pending.resolve(
				this.#closeReport(slots, [
					new SandboxCleanupError({ operation: 'dispose' }, { cause: error })
				])
			);
		}
	}

	#negotiate(provider: ProviderInfo, options: SandboxAcquireOptions) {
		const selection = this.#selection;

		if (selection === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		const identity = {
			operation: 'acquire' as const,
			providerId: selection.providerId
		};

		checkDeclaredCapabilities(provider.capabilities, options, identity);

		return resolvePolicy(selection.policy, provider, options.policy, identity);
	}

	async initialize(): Promise<void> {
		this.#assertOpen('configure');
		await this.#prepare();
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

			const slot = this.#slot(
				this.#negotiate(prepared.value.provider, options)
			);
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

			const sandbox = createSandbox(this.#owner(context, slot, result.value));

			checkRequirements(sandbox, options);

			return sandbox;
		} finally {
			scope.dispose();
		}
	}

	async status(): Promise<SandboxStatus> {
		if (this.#state !== 'closing' && this.#state !== 'closed') {
			await observe(this.#prepare());
		}

		const personal =
			this.#selection === undefined
				? undefined
				: this.#slots.get(policyKey(this.#selection.policy));
		const backend = personal?.backend;
		const failure = this.#failure ?? personal?.failure;
		const backends = this.#slots
			.values()
			.map((slot): SandboxBackendStatus =>
				Object.freeze({
					policy: slot.policy,
					state: slot.state,
					...(slot.backend !== undefined && { backendId: slot.backend.id })
				})
			)
			.toArray();
		const diagnostics = this.#diagnostics.snapshot();
		const provider = this.#providerInfos.find(
			(entry) => entry.id === this.#selection?.providerId
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
				capabilities: backend.capabilities,
				policy: backend.policy,
				policyDescription: backend.policyDescription
			}),
			...(failure !== undefined && { failure }),
			...(this.#closing !== undefined &&
				this.#state === 'closed' && { closeReport: await this.#closing })
		});
	}

	async providers(): Promise<readonly ProviderInfo[]> {
		if (this.#state === 'closing' || this.#state === 'closed') {
			throw new SandboxSessionClosingError({ operation: 'discover' });
		}

		await this.#prepare();

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
				left.lease === right.lease &&
				left.expiresAt === right.expiresAt;
}
