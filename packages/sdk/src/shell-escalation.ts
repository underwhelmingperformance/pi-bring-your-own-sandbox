import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type { SandboxBroker } from './broker.js';
import type { BrokerReviewRegistration } from './broker-review.js';
import type {
	Access,
	AccessProperty,
	SandboxOperationOptions
} from './contracts.js';
import { cleanDisplayText, cleanFullDisplayText } from './display-text.js';
import { chooseDisplayOption, notifyDisplay } from './display-ui.js';
import {
	InvalidSandboxRequestError,
	isSandboxError,
	SandboxPermissionDeniedError
} from './errors.js';
import type {
	EscalationDecision,
	EscalationEntry,
	EscalationRequest
} from './escalation-ledger.js';
import { appendLedgerEntry } from './escalation-ledger.js';
import type { EscalatedSandbox, EscalationPlan } from './escalation-plan.js';
import { observe, OperationScope } from './lifecycle.js';
import { accessPolicySchema, pathGrantsSchema } from './policy-model.js';
import { shellRequirements } from './profile-negotiation.js';
import type { ShellSettings } from './runtime-participant.js';
import { checker, denseArray, safeTextSchema } from './schemas.js';

const listItem = Type.Union([Type.KeyOf(accessPolicySchema), pathGrantsSchema]);

export const escalationListSchema = denseArray(listItem);

const isEscalationList = checker(escalationListSchema);
const comparePaths = (left: string, right: string) =>
	Number(left > right) - Number(left < right);

export const escalationJustificationSchema = Type.Refine(
	safeTextSchema,
	(value) => value.trim().length > 0
);

const isJustification = checker(escalationJustificationSchema);

function escalationAccess(list: unknown): Access {
	if (!isEscalationList(list)) {
		throw new InvalidSandboxRequestError({
			operation: 'exec',
			detail: { kind: 'request', field: 'escalate' }
		});
	}

	const read = new Set<string>();
	const write = new Set<string>();
	const access: Partial<Record<AccessProperty, 'needed'>> = {};

	for (const item of list) {
		if (typeof item === 'string') {
			access[item] = 'needed';
			continue;
		}

		const reads = item.read ?? [];
		const writes = item.write ?? [];

		for (const path of reads) {
			read.add(path);
		}

		for (const path of writes) {
			write.add(path);
		}
	}

	const reads = Object.freeze([...read].toSorted(comparePaths));
	const writes = Object.freeze([...write].toSorted(comparePaths));

	return Object.freeze({
		...access,
		...(read.size + write.size > 0 && {
			paths: Object.freeze({
				...(read.size > 0 && { read: reads }),
				...(write.size > 0 && { write: writes })
			})
		})
	});
}

type Decider = NonNullable<EscalationEntry['decider']>;
type EscalationData = Omit<EscalationRequest, 'destination'>;
type Dialect = 'bash' | 'powershell';

interface GrantDecision {
	readonly choice: EscalationDecision;
	readonly decider: Decider;
	readonly duration?: 'session' | 'always';
}

export function escalationInput(
	toolCallId: string,
	command: string,
	input: { readonly escalate?: unknown; readonly justification?: unknown }
): EscalationData | undefined {
	if (input.escalate === undefined) {
		return undefined;
	}

	if (!isJustification(input.justification)) {
		throw new InvalidSandboxRequestError({
			operation: 'exec',
			detail: { kind: 'request', field: 'justification' }
		});
	}

	return Object.freeze({
		toolCallId,
		command,
		justification: input.justification,
		access: escalationAccess(input.escalate)
	});
}

export function effectiveCommand(
	command: string,
	prefix: string | undefined
): string {
	return prefix ? `${prefix}\n${command}` : command;
}

export class PendingEscalation {
	readonly #pi: ExtensionAPI;
	readonly #context: ExtensionContext;
	readonly #input: EscalationData;
	readonly #scope: OperationScope;
	readonly #decisionFinished = new AbortController();
	readonly #settings: ShellSettings;
	readonly #broker: SandboxBroker;
	#plan: EscalationPlan | undefined;
	#request: EscalationRequest | undefined;
	#review: BrokerReviewRegistration | undefined;
	#failure: Error | undefined;
	#isFinished = false;
	#isClaimed = false;
	readonly decisionSignal: AbortSignal;

	constructor(
		pi: ExtensionAPI,
		context: ExtensionContext,
		input: EscalationData,
		settings: ShellSettings,
		broker: SandboxBroker
	) {
		this.#pi = pi;
		this.#context = context;
		this.#input = input;
		this.#settings = settings;
		this.#broker = broker;
		this.#scope = new OperationScope(
			{ operation: 'exec' },
			settings.lifetime,
			{},
			60_000
		);
		this.decisionSignal = AbortSignal.any([
			this.#scope.context.signal,
			this.#decisionFinished.signal
		]);
	}

	async #prepare(dialect: Dialect): Promise<void> {
		const config = await this.#settings.read(this.#context);

		this.#scope.check();

		if (!config.allowEscalation) {
			this.#complete('denied', { kind: 'configuration' });

			throw this.#refusal('allowEscalation');
		}

		const plan = await this.#broker.planEscalation(this.#context, {
			access: this.#input.access,
			...shellRequirements(dialect)
		});

		this.#scope.check();
		this.#plan = plan;

		const { paths: _raw, ...access } = this.#input.access;

		this.#request = Object.freeze({
			...this.#input,
			access: Object.freeze({
				...access,
				...(plan.paths !== undefined && { paths: plan.paths })
			}),
			destination: plan.destination
		});
	}

	#check(context: ExtensionContext, signal?: AbortSignal): void {
		if (signal?.aborted === true) {
			this.#scope.abort('caller');
		}

		this.#scope.check();
		this.#plan?.assertCurrent(context);
	}

	async #confirm(
		context: ExtensionContext,
		request: EscalationRequest,
		plan: EscalationPlan
	): Promise<GrantDecision | undefined> {
		const { signal } = this.#scope.context;
		const display = [
			cleanDisplayText('Allow sandbox escalation?'),
			cleanFullDisplayText('Command: ' + request.command),
			cleanFullDisplayText('Justification: ' + request.justification),
			cleanFullDisplayText(
				'Requested access: ' + JSON.stringify(request.access)
			),
			cleanFullDisplayText('Destination: ' + plan.label),
			cleanFullDisplayText(
				'Effective restrictions: ' + request.destination.effectiveRestrictions
			)
		];
		const sessionChoice =
			plan.readApproval?.coversRequest === true
				? 'Allow for session'
				: 'Allow and remember reads for session';
		const choices =
			plan.readApproval === undefined
				? ['Deny', 'Allow']
				: ['Deny', 'Allow', sessionChoice];
		const persistence = plan.readApproval?.persistence;
		const alwaysChoice =
			plan.readApproval?.coversRequest === true &&
			persistence?.paths.length === plan.readApproval.paths.length
				? 'Allow always'
				: 'Allow and save eligible reads';

		if (persistence !== undefined) {
			choices.push(alwaysChoice);
			display.push(
				cleanFullDisplayText(
					'Read roots to save: ' + JSON.stringify(persistence.paths)
				)
			);
		}

		const pending = observe(
			chooseDisplayOption(context, display, choices, { signal })
		);
		const answered = await Promise.race([pending, this.#scope.whenCancelled()]);

		if (answered.kind === 'cancelled') {
			throw this.#scope.cancellationError('not-started');
		}

		if (answered.kind === 'rejected') {
			throw answered.error;
		}

		const result = answered.value;

		if (result === undefined || !choices.includes(result)) {
			return;
		}

		return {
			choice: result === 'Deny' ? 'deny' : 'allow',
			decider: { kind: 'confirmation' },
			...(result === sessionChoice && { duration: 'session' }),
			...(result === alwaysChoice && { duration: 'always' })
		};
	}

	async #saveReadApproval(
		context: ExtensionContext,
		plan: EscalationPlan,
		request: EscalationRequest
	): Promise<void> {
		const persistence = plan.readApproval?.persistence;

		if (persistence === undefined) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}

		const writing = observe(persistence.save(this.#scope.context.signal));
		const result = await Promise.race([writing, this.#scope.whenCancelled()]);

		if (result.kind === 'cancelled') {
			throw this.#scope.cancellationError('not-started');
		}

		if (result.kind === 'rejected') {
			throw result.error;
		}

		this.#check(context);
		this.#broker.rememberReadApprovals(
			plan,
			request.toolCallId,
			persistence.paths
		);
		notifyDisplay(
			context,
			cleanFullDisplayText(
				'Saved read roots ' +
					JSON.stringify(persistence.paths) +
					' in ' +
					result.value
			),
			'info'
		);
	}

	#rememberedDecision(plan: EscalationPlan): GrantDecision | undefined {
		const toolCallIds = this.#broker.rememberedReadApprovals(plan);

		if (toolCallIds !== undefined) {
			return {
				choice: 'allow',
				decider: { kind: 'remembered-read', toolCallIds }
			};
		}

		return;
	}

	#refusal(field: string): SandboxPermissionDeniedError {
		return new SandboxPermissionDeniedError({
			operation: 'exec',
			detail: { kind: 'request', field }
		});
	}

	#complete(outcome: EscalationEntry['outcome'], decider?: Decider): void {
		if (this.#isFinished) {
			return;
		}

		this.#isFinished = true;
		this.#scope.dispose();
		this.#decisionFinished.abort();
		appendLedgerEntry(this.#pi, {
			kind: 'escalation',
			request: this.#request ?? this.#input,
			outcome,
			...(decider !== undefined && { decider })
		});
	}

	get configurationRefusalMessage(): string | undefined {
		const failure = this.#failure;

		return isSandboxError(failure, SandboxPermissionDeniedError) &&
			failure.detail?.kind === 'request' &&
			failure.detail.field === 'allowEscalation'
			? failure.message
			: undefined;
	}

	get request(): EscalationRequest | undefined {
		return this.#isFinished ? undefined : this.#request;
	}

	async prepare(dialect: Dialect): Promise<void> {
		try {
			const result = await Promise.race([
				observe(this.#prepare(dialect)),
				this.#scope.whenCancelled()
			]);

			if (result.kind === 'cancelled') {
				throw this.#scope.cancellationError('not-started');
			}

			if (result.kind === 'rejected') {
				throw result.error;
			}
		} catch (error) {
			this.#failure =
				error instanceof Error
					? error
					: new Error('Escalation preparation failed.', { cause: error });
			this.finish();
		}
	}

	get decisionDeadline(): number {
		return performance.now() + this.#scope.context.remainingMs();
	}

	bindReview(registration: BrokerReviewRegistration): void {
		this.#review = registration;
	}

	async open(
		context: ExtensionContext,
		command: string,
		options: SandboxOperationOptions
	): Promise<EscalatedSandbox> {
		if (this.#failure !== undefined) {
			throw this.#failure;
		}

		const request = this.request;
		const plan = this.#plan;

		if (
			request === undefined ||
			plan === undefined ||
			this.#isClaimed ||
			command !== request.command
		) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}

		this.#isClaimed = true;

		const signal = options.signal;
		const cancel = () => {
			this.#scope.abort('caller');
		};

		signal?.addEventListener('abort', cancel, { once: true });

		try {
			this.#check(context, signal);

			const recorded = this.#review?.claimDecision();

			if (recorded?.choice === 'conflict') {
				this.#complete('denied');

				throw new InvalidSandboxRequestError({ operation: 'exec' });
			}

			const decided: GrantDecision | undefined =
				recorded ??
				this.#rememberedDecision(plan) ??
				(await this.#confirm(context, request, plan));

			this.#check(context, signal);

			if (decided === undefined) {
				this.#complete('cancelled');

				throw this.#refusal('escalate');
			}

			if (decided.choice === 'deny') {
				this.#complete('denied', decided.decider);

				throw this.#refusal('escalate');
			}

			if (decided.duration === 'session') {
				this.#broker.rememberReadApprovals(plan, request.toolCallId);
			} else if (decided.duration === 'always') {
				await this.#saveReadApproval(context, plan, request);
			}

			this.#complete('allowed', decided.decider);

			return await plan.open(context, options);
		} finally {
			signal?.removeEventListener('abort', cancel);
			this.finish();
		}
	}

	invalidate(): void {
		this.#complete('cancelled');
	}

	finish(): void {
		if (this.#isFinished) {
			return;
		}

		const decision = this.#review?.decision();
		const isExpired =
			this.#scope.reason === 'deadline' ||
			this.#scope.context.remainingMs() <= 0;

		this.#complete(
			isExpired
				? 'expired'
				: decision?.choice === 'deny' || decision?.choice === 'conflict'
					? 'denied'
					: 'cancelled',
			decision?.choice === 'conflict' ? undefined : decision?.decider
		);
	}
}
