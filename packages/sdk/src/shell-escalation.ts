import { isDeepStrictEqual } from 'node:util';

import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
import { Type } from 'typebox';

import type {
	Access,
	AccessProperty,
	SandboxOperationOptions
} from './contracts.js';
import { ensureSandboxService } from './default-broker.js';
import { cleanDisplayText, cleanFullDisplayText } from './display-text.js';
import { chooseDisplayOption } from './display-ui.js';
import {
	InvalidSandboxRequestError,
	SandboxPermissionDeniedError,
	UnsupportedSandboxCapabilityError
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
import { runtimeSettings } from './runtime-settings.js';
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

	return {
		...access,
		...(read.size + write.size > 0 && {
			paths: {
				...(read.size > 0 && { read: [...read].toSorted(comparePaths) }),
				...(write.size > 0 && { write: [...write].toSorted(comparePaths) })
			}
		})
	};
}

type Decider = NonNullable<EscalationEntry['decider']>;
type PermissionDecider = Extract<Decider, { kind: 'permission-extension' }>;
type EscalationData = Omit<EscalationRequest, 'destination'>;
type Dialect = 'bash' | 'powershell';

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

	return {
		toolCallId,
		command,
		justification: input.justification,
		access: escalationAccess(input.escalate)
	};
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
	#plan: EscalationPlan | undefined;
	#request: EscalationRequest | undefined;
	#decision:
		| {
				readonly choice: EscalationDecision;
				readonly decider: PermissionDecider;
		  }
		| undefined;
	#failure: Error | undefined;
	#isFinished = false;
	#isClaimed = false;

	constructor(
		pi: ExtensionAPI,
		context: ExtensionContext,
		input: EscalationData
	) {
		this.#pi = pi;
		this.#context = context;
		this.#input = input;
		this.#scope = new OperationScope(
			{ operation: 'exec' },
			runtimeSettings(pi).lifetime,
			{},
			60_000
		);
	}

	async #prepare(dialect: Dialect): Promise<void> {
		const config = await runtimeSettings(this.#pi).read(this.#context);

		this.#scope.check();

		if (config.allowEscalation === false) {
			this.#complete('denied', { kind: 'configuration' });

			throw this.#refusal('allowEscalation');
		}

		const broker = ensureSandboxService(this.#pi);

		if (broker.planEscalation === undefined) {
			throw new UnsupportedSandboxCapabilityError({ operation: 'acquire' });
		}

		const plan = await broker.planEscalation(this.#context, {
			access: this.#input.access,
			processKinds: ['shell'],
			shells: [dialect]
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
		label: string
	): Promise<
		| { readonly choice: EscalationDecision; readonly decider: Decider }
		| undefined
	> {
		const { signal } = this.#scope.context;
		const display = [
			cleanDisplayText('Allow sandbox escalation?'),
			cleanFullDisplayText('Command: ' + request.command),
			cleanFullDisplayText('Justification: ' + request.justification),
			cleanFullDisplayText(
				'Requested access: ' + JSON.stringify(request.access)
			),
			cleanFullDisplayText('Destination: ' + label),
			cleanFullDisplayText(
				'Effective restrictions: ' + request.destination.effectiveRestrictions
			)
		];
		const pending = observe(
			chooseDisplayOption(context, display, ['Deny', 'Allow'], { signal })
		);
		const answered = await Promise.race([pending, this.#scope.whenCancelled()]);

		if (answered.kind === 'cancelled') {
			throw this.#scope.cancellationError('not-started');
		}

		if (answered.kind === 'rejected') {
			throw answered.error;
		}

		const result = answered.value;

		if (result !== 'Allow' && result !== 'Deny') {
			return;
		}

		return {
			choice: result === 'Allow' ? 'allow' : 'deny',
			decider: { kind: 'confirmation' }
		};
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
		appendLedgerEntry(this.#pi, {
			kind: 'escalation',
			request: this.#request ?? this.#input,
			outcome,
			...(decider !== undefined && { decider })
		});
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

	verify(context: ExtensionContext, input: EscalationData): void {
		if (
			this.#context.sessionManager.getSessionId() ===
				context.sessionManager.getSessionId() &&
			isDeepStrictEqual(input, this.#input)
		) {
			return;
		}

		this.#complete('cancelled');

		throw new InvalidSandboxRequestError({ operation: 'exec' });
	}

	record(choice: EscalationDecision, extension: string): void {
		if (
			this.#isFinished ||
			this.#isClaimed ||
			this.#request === undefined ||
			this.#scope.context.remainingMs() <= 0 ||
			this.#scope.reason !== undefined
		) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}

		try {
			this.#plan?.assertCurrent(this.#context);
		} catch (error) {
			throw new InvalidSandboxRequestError(
				{ operation: 'exec' },
				{ cause: error }
			);
		}

		if (this.#decision !== undefined) {
			if (this.#decision.choice === choice) {
				return;
			}

			this.#failure = new InvalidSandboxRequestError({ operation: 'exec' });
			this.#complete('denied');

			throw this.#failure;
		}

		this.#decision = {
			choice,
			decider: { kind: 'permission-extension', extension }
		};
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

			const decided =
				this.#decision ?? (await this.#confirm(context, request, plan.label));

			this.#check(context, signal);

			if (decided === undefined) {
				this.#complete('cancelled');

				throw this.#refusal('escalate');
			}

			if (decided.choice === 'deny') {
				this.#complete('denied', decided.decider);

				throw this.#refusal('escalate');
			}

			this.#complete('allowed', decided.decider);

			return await plan.open(context, options);
		} finally {
			signal?.removeEventListener('abort', cancel);
			this.finish();
		}
	}

	finish(): void {
		if (this.#isFinished) {
			return;
		}

		const decision = this.#decision;
		const isExpired =
			this.#scope.reason === 'deadline' ||
			this.#scope.context.remainingMs() <= 0;

		this.#complete(
			isExpired
				? 'expired'
				: decision?.choice === 'deny'
					? 'denied'
					: 'cancelled',
			decision?.decider
		);
	}
}
