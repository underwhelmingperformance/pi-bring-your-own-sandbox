import { randomUUID } from 'node:crypto';

import { Type } from 'typebox';

import { acquireOptions, checkRequirements } from './acquire-options.js';
import { snapshotBackend, snapshotRecovery } from './backend-snapshot.js';
import { validateBackend } from './backend-validation.js';
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
	SandboxOperationContext
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
import type {
	BrokerState,
	ConfiguredProviderV1,
	ProviderInfo,
	ProviderSelection,
	ProviderServiceV1,
	SandboxStatus
} from './protocol.js';
import { callable, checker } from './schemas.js';
import {
	isRecord,
	isRecovery,
	snapshotCapabilities,
	snapshotPolicies
} from './validation.js';

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

const isDisposable = checker(
	Type.Object({ dispose: callable<Disposable['dispose']>() })
);

export class SandboxGeneration {
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
	#configurationSource: 'personal' | 'project' | undefined;
	#prepared: Promise<Prepared> | undefined;
	#opening:
		| Promise<Exclude<Settlement<SandboxBackend>, { kind: 'abandoned' }>>
		| undefined;
	#backend: SandboxBackend | undefined;
	#candidate: unknown;
	#recovery: RecoveryDescriptor = { kind: 'none' };
	#candidateRecovery: RecoveryDescriptor | undefined;
	#hasRecovery = false;
	#hasInvokedOpen = false;
	#isOpenCleanupConfirmed = false;
	#failure: SandboxErrorInfo | undefined;
	#isUncertain = false;
	#disposing: Promise<boolean> | undefined;
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

	#assertOpen(operation: SandboxOperation): void {
		if (this.#state === 'closing' || this.#state === 'closed') {
			throw new SandboxSessionClosingError({ operation });
		}

		if (this.#failure !== undefined) {
			throw this.#failure;
		}
	}

	#normalise(cause: unknown, operation: SandboxOperation): SandboxErrorInfo {
		const recovery =
			this.#recovery.kind === 'none'
				? (this.#candidateRecovery ?? this.#recovery)
				: this.#recovery;
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
			...(this.#backend !== undefined && { backendId: this.#backend.id }),
			...(!this.#isOpenCleanupConfirmed &&
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
				this.#dependencies.providers().map((provider) => {
					const capabilities = snapshotCapabilities(provider.capabilities);
					const policies = snapshotPolicies(provider.policies);

					return Object.freeze({
						id: provider.id,
						label: provider.label,
						capabilities,
						policies,
						configure: provider.configure.bind(provider)
					});
				})
			);

			this.#providerInfos = Object.freeze(
				providers.map((provider) =>
					Object.freeze({
						id: provider.id,
						label: provider.label,
						capabilities: snapshotCapabilities(provider.capabilities),
						policies: snapshotPolicies(provider.policies)
					})
				)
			);

			const config = await this.#dependencies.readConfig(this.#session);

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

	#start(): Promise<
		Exclude<Settlement<SandboxBackend>, { kind: 'abandoned' }>
	> {
		if (this.#opening !== undefined) {
			return this.#opening;
		}

		const pending = Promise.withResolvers<SandboxBackend>();

		this.#opening = observe(pending.promise);
		this.#state = 'opening';
		void this.#open(pending);

		return this.#opening;
	}

	#reportRecovery(value: unknown): void {
		if (
			!isRecovery(value) ||
			(this.#recovery.kind === 'allocation' && value.kind === 'none')
		) {
			throw new InvalidSandboxDeclarationError({ operation: 'open' });
		}

		this.#recordRecovery(value);
		this.#hasRecovery = true;
	}

	#recordRecovery(recovery: RecoveryDescriptor): void {
		this.#recovery = snapshotRecovery(recovery);
	}

	async #allocate(scope: OperationScope): Promise<SandboxBackend> {
		const prepared = await this.#prepare();

		scope.check();
		this.#hasInvokedOpen = true;

		let isOpening = true;
		let candidate: unknown;

		try {
			candidate = await prepared.configured.open(
				{
					generationId: this.#id,
					sessionId: this.#session.sessionId,
					hostWorkspace: this.#session.workspace,
					policy: this.#selectionPolicy()
				},
				{
					...scope.context,
					reportRecovery: (recovery) => {
						if (!isOpening || this.#isOpenCleanupConfirmed) {
							throw new InvalidSandboxDeclarationError({ operation: 'open' });
						}

						this.#reportRecovery(recovery);
					},
					confirmCleanup: () => {
						if (!isOpening) {
							throw new InvalidSandboxDeclarationError({ operation: 'open' });
						}

						this.#isOpenCleanupConfirmed = true;
					}
				}
			);
		} finally {
			isOpening = false;
		}

		this.#candidate = candidate;

		if (isRecord(candidate) && isRecovery(candidate.recovery)) {
			this.#candidateRecovery = snapshotRecovery(candidate.recovery);

			if (!this.#hasRecovery) {
				this.#recordRecovery(candidate.recovery);
			}
		}

		if (this.#isOpenCleanupConfirmed) {
			this.#isOpenCleanupConfirmed = false;

			throw new InvalidSandboxDeclarationError({ operation: 'open' });
		}

		if (
			scope.reason !== undefined ||
			this.#state === 'closing' ||
			this.#state === 'closed'
		) {
			const isDisposed = await this.#dispose();

			throw scope.cancellationError(isDisposed ? 'confirmed' : 'unknown');
		}

		const backend = snapshotBackend(
			validateBackend(candidate, prepared.provider, this.#selectionPolicy())
		);

		if (
			(backend.recovery.kind === 'allocation' && !this.#hasRecovery) ||
			!isSameRecovery(this.#recovery, backend.recovery)
		) {
			throw new InvalidSandboxDeclarationError({
				operation: 'open',
				providerId: prepared.provider.id
			});
		}

		this.#recordRecovery(backend.recovery);

		this.#candidate = backend;
		this.#backend = backend;
		this.#state = 'ready';

		return backend;
	}

	#selectionPolicy() {
		if (this.#selection === undefined) {
			throw new SandboxInitialisationError({ operation: 'open' });
		}

		return this.#selection.policy;
	}

	async #open(pending: PromiseWithResolvers<SandboxBackend>): Promise<void> {
		const scope = new OperationScope(
			{ operation: 'open' },
			this.#lifetime.signal,
			{},
			60_000
		);

		try {
			const allocation = Promise.try(() => this.#allocate(scope));
			const completion = observe(allocation);
			const first = await Promise.race([completion, scope.whenCancelled()]);

			if (!this.#hasInvokedOpen && first.kind === 'cancelled') {
				throw scope.cancellationError('not-started');
			}

			const result =
				first.kind === 'cancelled'
					? await settleOperation(scope, allocation)
					: first;

			if (result.kind === 'abandoned') {
				this.#isUncertain = true;

				throw new UnconfirmedSandboxTerminationError({
					operation: 'open',
					...(scope.reason !== undefined && { reason: scope.reason }),
					...(this.#recovery.kind !== 'none' && { recovery: this.#recovery })
				});
			}

			if (result.kind === 'rejected') {
				if (
					this.#candidate === undefined &&
					this.#recovery.kind === 'allocation'
				) {
					this.#isUncertain = !this.#isOpenCleanupConfirmed;
				}

				throw result.error;
			}

			pending.resolve(result.value);
		} catch (error_) {
			let error = this.#normalise(error_, 'open');

			this.#fail(error);

			if (this.#candidate !== undefined) {
				const isDisposed = await this.#dispose();

				if (isDisposed && !this.#isUncertain) {
					this.#isOpenCleanupConfirmed = true;
					error = this.#normalise(error_, 'open');
					this.#failure = error;
				}
			}

			pending.reject(error);
		} finally {
			scope.dispose();
		}
	}

	#owner(context: SandboxContext, backend: SandboxBackend): SandboxOwner {
		const selection = this.#selection;

		if (selection === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		return {
			identity: {
				providerId: selection.providerId,
				backendId: backend.id,
				recovery: this.#recovery
			},
			generationId: this.#id,
			backend,
			lifetime: this.#lifetime.signal,
			operations: this.#operations,
			mutations: this.#mutations,
			assertLive: (operation) => {
				this.#assertContext(context, operation);
				this.#assertOpen(operation);
			},
			markUnhealthy: (failure) => {
				this.#fail(failure);
			}
		};
	}

	#dispose(): Promise<boolean> {
		if (this.#disposing !== undefined) {
			return this.#disposing;
		}

		const candidate = this.#candidate;

		if (candidate === undefined) {
			return Promise.resolve(
				!this.#isUncertain &&
					(this.#isOpenCleanupConfirmed || this.#recovery.kind === 'none')
			);
		}

		const pending = Promise.withResolvers<boolean>();

		this.#disposing = pending.promise;
		void this.#release(candidate, pending);

		return pending.promise;
	}

	async #release(
		candidate: unknown,
		pending: PromiseWithResolvers<boolean>
	): Promise<void> {
		const scope = new OperationScope(
			{ operation: 'dispose' },
			new AbortController().signal,
			{},
			10_000
		);

		try {
			if (!isDisposable(candidate)) {
				throw new SandboxCleanupError({ operation: 'dispose' });
			}

			const result = await Promise.race([
				observe(Promise.try(() => candidate.dispose(scope.context))),
				scope.whenCancelled()
			]);

			if (result.kind !== 'resolved') {
				throw new SandboxCleanupError(
					{
						operation: 'dispose',
						...(this.#recovery.kind !== 'none' && { recovery: this.#recovery })
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
						...(this.#recovery.kind !== 'none' && { recovery: this.#recovery })
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
		isConfirmed: boolean,
		failures: readonly SandboxErrorInfo[]
	): SandboxCloseReport {
		const recoveries = Object.freeze(
			isConfirmed
				? []
				: [
						...(this.#recovery.kind === 'allocation' ? [this.#recovery] : []),
						...(this.#candidateRecovery?.kind === 'allocation' &&
						!isSameRecovery(this.#recovery, this.#candidateRecovery)
							? [this.#candidateRecovery]
							: [])
					]
		);

		return Object.freeze({
			confirmed: isConfirmed,
			recoveries,
			failures: Object.freeze([...failures])
		});
	}

	async #finishClose(
		pending: PromiseWithResolvers<SandboxCloseReport>
	): Promise<void> {
		try {
			if (this.#opening !== undefined) {
				await this.#opening;
			}

			await this.#operations.drain();

			const isDisposed = await this.#dispose();
			const isConfirmed = isDisposed && !this.#isUncertain;
			const failures = [...this.#cleanupFailures];

			if (this.#isUncertain && this.#failure !== undefined) {
				failures.unshift(this.#failure);
			}

			this.#state = 'closed';
			pending.resolve(this.#closeReport(isConfirmed, failures));
		} catch (error) {
			this.#state = 'closed';
			pending.resolve(
				this.#closeReport(false, [
					new SandboxCleanupError({ operation: 'dispose' }, { cause: error })
				])
			);
		}
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

			const result = await Promise.race([this.#start(), scope.whenCancelled()]);

			if (result.kind === 'cancelled') {
				throw scope.cancellationError('not-started');
			}

			scope.check();

			if (result.kind === 'rejected') {
				throw result.error;
			}

			this.#assertContext(context, 'acquire');
			this.#assertOpen('acquire');

			const sandbox = createSandbox(this.#owner(context, result.value));

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

		const backend = this.#backend;

		return Object.freeze({
			generationId: this.#id,
			state: this.#state,
			...(this.#selection !== undefined && { selection: this.#selection }),
			...(backend !== undefined && {
				backendId: backend.id,
				workspace: backend.workspace,
				capabilities: backend.capabilities,
				policy: backend.policy,
				policyDescription: backend.policyDescription
			}),
			...(this.#failure !== undefined && { failure: this.#failure }),
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
