import type { RegisteredReview } from './broker-review.js';
import {
	describeReviewDestination,
	resolvedReviewSource,
	reviewRegistrationInput,
	ReviewState
} from './broker-review.js';
import { reportCleanup } from './cleanup-report.js';
import { inspectContext } from './context.js';
import type {
	ReviewedToolCall,
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxCopyOptions,
	SandboxHost
} from './contracts.js';
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

function reviewCallKey(sessionId: string, call: ReviewedToolCall): string {
	return JSON.stringify([sessionId, call.toolName, call.toolCallId]);
}

export class SandboxBroker implements BrokerService {
	readonly #dependencies: GenerationDependencies;
	readonly #reviewIdentities = new ReviewIdentities<RegisteredReview>();
	readonly #liveReviewCalls = new Set<string>();
	#generation: SandboxGeneration | undefined;
	#isClosing = false;
	readonly id: string;

	constructor(
		id: string,
		pi: SandboxHost,
		dependencies: GenerationDependencies,
		lifecycle: 'session' | 'owner' = 'session'
	) {
		this.id = id;
		this.#dependencies = dependencies;

		pi.on('tool_execution_start', (event, context) => {
			const session = inspectContext(context, 'acquire');

			this.#liveReviewCalls.add(reviewCallKey(session.sessionId, event));
		});
		pi.on('tool_result', (event, context) => {
			const session = inspectContext(context, 'acquire');

			this.#liveReviewCalls.delete(reviewCallKey(session.sessionId, event));
		});
		pi.on('turn_end', () => {
			this.#liveReviewCalls.clear();
		});

		if (lifecycle === 'owner') {
			return;
		}

		pi.on('session_start', async (_event, context) => {
			if (this.#isClosing) {
				return;
			}

			await this.#resolve(context).initialize();
		});
		pi.on('session_shutdown', async (_event, context) => {
			const report = await this.close(context);

			reportCleanup(pi, context, report);
		});
	}

	#resolve(context: SandboxContext): SandboxGeneration {
		inspectContext(context, 'acquire');
		this.#generation ??= new SandboxGeneration(context, this.#dependencies);

		if (this.#isClosing) {
			void this.#generation.close();
		}

		return this.#generation;
	}

	acquire(context: SandboxContext, options?: SandboxAcquireOptions) {
		return this.#resolve(context).acquire(context, options);
	}

	copy(
		context: SandboxContext,
		source: CopySourceIdentity,
		options?: SandboxCopyOptions
	) {
		return this.#resolve(context).copy(context, source, options);
	}

	negotiate(context: SandboxContext, options?: SandboxAcquireOptions) {
		return this.#resolve(context).negotiate(context, options);
	}

	planEscalation(context: SandboxContext, options: SandboxAcquireOptions) {
		return this.#resolve(context).planEscalation(context, options);
	}

	async prepareReview(context: SandboxContext, input: unknown) {
		const route = reviewRegistrationInput(input);
		const session = inspectContext(context, 'acquire');
		const generation = this.#resolve(context);
		const target = await describeReviewDestination(
			generation,
			context,
			route.escalation
		);
		const state = new ReviewState(route.decisionDeadline);
		const registration = this.#reviewIdentities.register(session, route.call, {
			route,
			target,
			generation,
			state
		});
		const key = reviewCallKey(session.sessionId, route.call);

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

		const session = inspectContext(context, 'acquire');
		const key = reviewCallKey(session.sessionId, query);

		if (!this.#liveReviewCalls.has(key)) {
			return;
		}

		const proof = this.#reviewIdentities.resolve(session, query, sourceId);

		if (proof === undefined || !proof.value.state.isCurrent()) {
			return;
		}

		proof.value.state.markReviewed();

		return resolvedReviewSource(
			context,
			proof.value,
			query.extensionSource,
			() => proof.isCurrent() && this.#liveReviewCalls.has(key),
			this.#dependencies.appendLedger
		);
	}

	close(context: SandboxContext): Promise<SandboxCloseReport> {
		this.#isClosing = true;
		this.#reviewIdentities.close();
		this.#liveReviewCalls.clear();

		return this.#resolve(context).close();
	}

	status(context: SandboxContext): Promise<SandboxStatus> {
		return this.#resolve(context).status();
	}

	providers(context: SandboxContext): Promise<readonly ProviderInfo[]> {
		return this.#resolve(context).providers();
	}
}
