import type { RegisteredReview } from './broker-review.js';
import {
	describeReviewDestination,
	resolvedReviewSource,
	ReviewState
} from './broker-review.js';
import { failedCloseReport, reportCleanup } from './cleanup-report.js';
import { SandboxSession } from './context.js';
import type {
	ReviewedToolCall,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxHost,
	ShellDialect
} from './contracts.js';
import {
	InvalidSandboxRequestError,
	SandboxInitialisationError
} from './errors.js';
import type { EscalationPlan } from './escalation-plan.js';
import type { GenerationDependencies } from './generation.js';
import { SandboxGeneration } from './generation.js';
import type {
	BrokerService,
	CopySourceIdentity,
	ProviderInfo,
	SandboxStatus
} from './protocol.js';
import type { ReviewQuery } from './review-identities.js';
import { isReviewQuery, ReviewIdentities } from './review-identities.js';
import type { PendingEscalation } from './shell-escalation.js';

function reviewCallKey(sessionId: string, call: ReviewedToolCall): string {
	return JSON.stringify([sessionId, call.toolName, call.toolCallId]);
}

export class SandboxBroker implements BrokerService {
	readonly #dependencies: GenerationDependencies;
	readonly #abortConfig: (() => void) | undefined;
	readonly #reviewIdentities = new ReviewIdentities<RegisteredReview>();
	readonly #liveReviewCalls = new Set<string>();
	readonly #readApprovals = new Map<string, string>();
	#current:
		| {
				readonly session: SandboxSession;
				readonly generation: SandboxGeneration;
		  }
		| undefined;
	#isClosing = false;

	constructor(
		pi: SandboxHost,
		dependencies: GenerationDependencies,
		session?: SandboxSession,
		abortConfig?: () => void
	) {
		this.#dependencies = dependencies;
		this.#abortConfig = abortConfig;

		pi.on('tool_execution_start', (event, context) => {
			const { session } = this.#resolve(context);

			this.#liveReviewCalls.add(reviewCallKey(session.sessionId, event));
		});
		pi.on('tool_result', (event, context) => {
			const { session } = this.#resolve(context);

			this.#liveReviewCalls.delete(reviewCallKey(session.sessionId, event));
		});
		pi.on('turn_end', () => {
			this.#liveReviewCalls.clear();
		});

		if (session !== undefined) {
			this.#start(session);

			return;
		}

		pi.on('session_start', async (_event, context) => {
			if (this.#isClosing) {
				return;
			}

			const session = await SandboxSession.capture(context);

			await this.#start(session).initialize();
		});
		pi.on('session_shutdown', async (_event, context) => {
			const report = await this.close();

			reportCleanup(pi, context, report);
		});
	}

	#start(session: SandboxSession): SandboxGeneration {
		const generation = new SandboxGeneration(session, this.#dependencies);

		this.#current = { session, generation };

		return generation;
	}

	#resolve(context: SandboxContext) {
		const current = this.#current;

		if (current === undefined) {
			throw new SandboxInitialisationError({ operation: 'acquire' });
		}

		current.session.check(context, 'acquire');

		return current;
	}

	acquire(context: SandboxContext, options?: SandboxAcquireOptions) {
		return this.#resolve(context).generation.acquire(context, options);
	}

	copy(
		context: SandboxContext,
		source: CopySourceIdentity,
		options?: SandboxAcquireOptions
	) {
		return this.#resolve(context).generation.copy(context, source, options);
	}

	negotiate(context: SandboxContext, options?: SandboxAcquireOptions) {
		return this.#resolve(context).generation.negotiate(context, options);
	}

	planEscalation(context: SandboxContext, options: SandboxAcquireOptions) {
		return this.#resolve(context).generation.planEscalation(context, options);
	}

	rememberReadApprovals(
		plan: EscalationPlan,
		toolCallId: string,
		paths = plan.readApproval?.paths
	): void {
		if (paths === undefined || plan.destination.kind !== 'provider') {
			return;
		}

		const { providerId } = plan.destination;

		for (const path of paths) {
			this.#readApprovals.set(JSON.stringify([providerId, path]), toolCallId);
		}
	}

	rememberedReadApprovals(plan: EscalationPlan): readonly string[] | undefined {
		if (
			plan.readApproval?.coversRequest !== true ||
			plan.destination.kind !== 'provider'
		) {
			return;
		}

		const { providerId } = plan.destination;
		const toolCalls = new Set<string>();

		for (const path of plan.readApproval.paths) {
			const toolCallId = this.#readApprovals.get(
				JSON.stringify([providerId, path])
			);

			if (toolCallId === undefined) {
				return;
			}

			toolCalls.add(toolCallId);
		}

		return [...toolCalls];
	}

	async prepareReview(
		context: SandboxContext,
		call: ReviewedToolCall & { readonly toolName: ShellDialect },
		command: string,
		pending?: PendingEscalation
	) {
		const escalation = pending?.request;

		if (escalation !== undefined && escalation.command !== command) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}

		const { session, generation } = this.#resolve(context);
		const target = await describeReviewDestination(
			generation,
			session.context,
			call.toolName,
			escalation
		);
		const state = new ReviewState(
			pending?.decisionDeadline,
			pending?.decisionSignal
		);
		const registration = this.#reviewIdentities.register(session, call, {
			call,
			command,
			...(escalation !== undefined && { escalation }),
			target,
			generation,
			state
		});
		const key = reviewCallKey(session.sessionId, call);

		return state.bind({
			issue: (query) =>
				this.#liveReviewCalls.has(key) && state.isCurrent()
					? registration.issue(query)
					: undefined,
			revoke: registration.revoke
		});
	}

	resolveReviewSource(
		context: SandboxContext,
		query: ReviewQuery,
		sourceId: string
	) {
		if (!isReviewQuery(query)) {
			return;
		}

		const { session } = this.#resolve(context);
		const key = reviewCallKey(session.sessionId, query);

		if (!this.#liveReviewCalls.has(key)) {
			return;
		}

		const proof = this.#reviewIdentities.resolve(session, query, sourceId);

		if (proof === undefined || !proof.value.state.isCurrent()) {
			return;
		}

		return resolvedReviewSource(
			context,
			proof.value,
			query.extensionSource,
			() => proof.isCurrent() && this.#liveReviewCalls.has(key),
			this.#dependencies.appendLedger
		);
	}

	close(): Promise<SandboxCloseReport> {
		const generation = this.#current?.generation;

		if (generation === undefined) {
			return Promise.resolve(
				failedCloseReport(
					new SandboxInitialisationError({ operation: 'dispose' })
				)
			);
		}

		if (this.#isClosing) {
			return generation.close();
		}

		this.#isClosing = true;
		this.#reviewIdentities.close();
		this.#readApprovals.clear();
		this.#liveReviewCalls.clear();

		const closing = generation.close();

		this.#abortConfig?.();

		return closing;
	}

	status(context: SandboxContext): Promise<SandboxStatus> {
		return this.#resolve(context).generation.status();
	}

	providers(context: SandboxContext): Promise<readonly ProviderInfo[]> {
		return this.#resolve(context).generation.providers();
	}
}
