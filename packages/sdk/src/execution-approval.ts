import type { ExtensionContext } from '@earendil-works/pi-coding-agent';

import type {
	ApprovalContext,
	ApprovalDecision,
	ApprovalPolicy,
	ApprovalPolicyInfo,
	ExecutionApprovalRequest
} from './approval-contracts.js';
import {
	ApprovalPolicyError,
	ApprovalPolicyNotFoundError,
	ApprovalUnavailableError,
	DuplicateApprovalPolicyError,
	InvalidApprovalRequestError,
	isApprovalError
} from './approval-errors.js';
import {
	approvalDecisionSchema,
	executionApprovalRequestSchema
} from './approval-schemas.js';
import { inspectContext } from './context.js';
import type { SandboxHost, SandboxOperationOptions } from './contracts.js';
import {
	isSandboxError,
	SandboxSessionClosingError,
	StaleSandboxHandleError
} from './errors.js';
import {
	discoverServices,
	ensureExtensionService,
	publishService
} from './extension-services.js';
import { operationOptions } from './file-input.js';
import { observe, OperationScope } from './lifecycle.js';
import { snapshotProcessRequest } from './process-input.js';
import { runtimeSettings } from './runtime-settings.js';
import { checker } from './schemas.js';
import {
	approvalPolicyDeclarationSchema,
	approvalPolicyServiceSchema,
	approvalServiceSchema,
	configuredApprovalPolicySchema
} from './service-schemas.js';
import { isRecord } from './validation.js';

/**
Discovery channel for independent execution approval policy extensions.
*/
export const APPROVAL_POLICY_CHANNEL = 'pi-byos:discovery:v1:approval-policies';
/**
Discovery channel for the runtime's independent approval service.
*/
export const APPROVAL_SERVICE_CHANNEL = 'pi-byos:discovery:v1:approvals';

/**
A policy with validated extension-owned configuration captured in its decision closure.
*/
export interface ConfiguredApprovalPolicyV1 {
	/**
	Review one request within the supplied cancellation and deadline context.
	*/
	readonly decide: (
		request: ExecutionApprovalRequest,
		context: ApprovalContext
	) => Promise<ApprovalDecision>;
}
/**
Versioned policy declaration exchanged through Pi's runtime event bus.
*/
export interface ApprovalPolicyServiceV1 {
	/**
	Registered policy identity, which must match its discovery advertisement.
	*/
	readonly id: string;
	/**
	Human-readable description for policy enumeration.
	*/
	readonly label: string;
	/**
 Validate opaque extension settings and return the configured decision method.
 */
	readonly configure: (input: unknown) => ConfiguredApprovalPolicyV1;
}
/**
Versioned approval service, independent of sandbox provider allocation.
*/
export interface ApprovalServiceV1 {
	/**
 Stop pending requests and permanently close this runtime service.
 */
	readonly close: () => void;
	/**
	Unique runtime service identity used across independently installed SDK copies.
	*/
	readonly id: string;
	/**
 Obtain a fresh decision without executing or allocating a backend.
 */
	readonly request: (
		context: ExtensionContext,
		request: ExecutionApprovalRequest,
		options?: SandboxOperationOptions
	) => Promise<ApprovalDecision>;
	/**
	Enumerate immutable policy identities without allocating execution resources.
	*/
	readonly policies: () => readonly ApprovalPolicyInfo[];
}

const isPolicy = checker(approvalPolicyServiceSchema);
const isApprovalService = checker(approvalServiceSchema);
const isConfiguredPolicy = checker(configuredApprovalPolicySchema);
const isDecision = checker(approvalDecisionSchema);
const isRequest = checker(executionApprovalRequestSchema);
const isPolicyDeclaration = checker(approvalPolicyDeclarationSchema);

/**
Register during an extension factory. Registration does not select the policy.
*/
export function registerApprovalPolicy<Config>(
	pi: SandboxHost,
	policy: ApprovalPolicy<Config>
): void {
	if (!isPolicyDeclaration(policy)) {
		throw new ApprovalPolicyError();
	}

	const validate = policy.validateConfig.bind(policy);
	const decide = policy.decide.bind(policy);

	publishService(
		pi.events,
		APPROVAL_POLICY_CHANNEL,
		Object.freeze({
			id: policy.id,
			label: policy.label,
			configure(input: unknown) {
				const config = validate(input);

				if (isRecord(config) && typeof config.then === 'function') {
					void Promise.allSettled([Promise.resolve(config)]);

					throw new ApprovalPolicyError();
				}

				return Object.freeze({
					decide: (
						request: ExecutionApprovalRequest,
						context: ApprovalContext
					) => decide(request, context, config)
				});
			}
		})
	);
}

function snapshotRequest(
	request: ExecutionApprovalRequest
): ExecutionApprovalRequest {
	if (!isRequest(request)) {
		throw new InvalidApprovalRequestError();
	}

	const process = snapshotProcessRequest(request.process);

	return Object.freeze({
		process,
		justification: request.justification,
		destination: Object.freeze({
			...request.destination,
			workspace: Object.freeze({ ...request.destination.workspace })
		})
	});
}

export async function boundedApproval<Result>(
	scope: OperationScope,
	effect: () => Promise<Result>
): Promise<Result> {
	scope.check();

	const pending = observe(
		Promise.try(() => {
			scope.check();

			return effect();
		})
	);
	const result = await Promise.race([pending, scope.whenCancelled()]);

	scope.check();

	if (result.kind === 'cancelled') {
		throw scope.cancellationError('not-started');
	}

	if (result.kind === 'rejected') {
		throw result.error;
	}

	return result.value;
}

class ApprovalService implements ApprovalServiceV1 {
	readonly #pi: SandboxHost;
	readonly #runtimeLifetime: AbortSignal;
	readonly #lifetime = new AbortController();
	#policies: readonly ApprovalPolicyServiceV1[] | undefined;
	#configured: Promise<ConfiguredApprovalPolicyV1> | undefined;
	#sessionId: string | undefined;
	#promptTail = Promise.resolve();
	readonly id: string;

	constructor(id: string, pi: SandboxHost) {
		this.id = id;
		this.#pi = pi;
		this.#runtimeLifetime = runtimeSettings(pi).lifetime;
		pi.on('session_shutdown', () => {
			this.close();
		});
	}

	async #prompt(
		request: ExecutionApprovalRequest,
		context: ApprovalContext
	): Promise<ApprovalDecision> {
		if (!context.pi.hasUI) {
			throw new ApprovalUnavailableError();
		}

		const preceding = this.#promptTail;
		const prompt = (async () => {
			await preceding;

			if (context.signal.aborted || context.remainingMs() <= 0) {
				return { kind: 'deny' as const };
			}

			const process = request.process;
			const command =
				process.kind === 'shell'
					? process.command
					: JSON.stringify([process.executable, ...process.args]);
			const environment =
				process.env === undefined
					? ''
					: `\nEnvironment overrides: ${Object.keys(process.env).join(', ')}`;
			const message = `${request.destination.label}\n${request.destination.policyDescription}\nWorking directory: ${process.cwd ?? request.destination.workspace.root}${environment}\n\n${command}\n\n${request.justification}`;
			const isAllowed = await context.pi.ui.confirm(
				'Approve process execution?',
				message,
				{
					signal: context.signal,
					timeout: Math.max(1, context.remainingMs())
				}
			);

			return { kind: isAllowed ? ('allow' as const) : ('deny' as const) };
		})();

		this.#promptTail = (async () => {
			await observe(prompt);
		})();

		return prompt;
	}

	async #configure(
		context: ExtensionContext
	): Promise<ConfiguredApprovalPolicyV1> {
		const config = await runtimeSettings(this.#pi).read(context);
		const selection = config.approval ?? { policy: 'user' };
		const policy = this.#available().find(
			(candidate) => candidate.id === selection.policy
		);

		if (policy === undefined) {
			throw new ApprovalPolicyNotFoundError();
		}

		const configured: unknown = policy.configure(
			Object.hasOwn(selection, 'config') ? selection.config : {}
		);

		if (!isConfiguredPolicy(configured)) {
			throw new ApprovalPolicyError();
		}

		return Object.freeze({ decide: configured.decide.bind(configured) });
	}

	#available() {
		const prompt = this.#prompt.bind(this);

		this.#policies ??= Object.freeze([
			...['user', 'always', 'never'].map((id) => ({
				id,
				label: id,
				configure(input: unknown) {
					if (!isRecord(input) || Object.keys(input).length > 0) {
						throw new ApprovalPolicyError();
					}

					return {
						decide: (
							request: ExecutionApprovalRequest,
							context: ApprovalContext
						) =>
							id === 'user'
								? prompt(request, context)
								: Promise.resolve({
										kind:
											id === 'always' ? ('allow' as const) : ('deny' as const)
									})
					};
				}
			})),
			...discoverServices(
				this.#pi.events,
				APPROVAL_POLICY_CHANNEL,
				isPolicy,
				() => new DuplicateApprovalPolicyError()
			)
		]);

		const ids = new Set(this.#policies.map((policy) => policy.id));

		if (ids.size !== this.#policies.length) {
			throw new DuplicateApprovalPolicyError();
		}

		return this.#policies;
	}

	close(): void {
		this.#lifetime.abort();
	}

	policies() {
		return Object.freeze(
			this.#available().map(({ id, label }) => Object.freeze({ id, label }))
		);
	}

	async request(
		context: ExtensionContext,
		request: ExecutionApprovalRequest,
		options?: SandboxOperationOptions
	): Promise<ApprovalDecision> {
		const identity = inspectContext(context, 'exec');

		this.#sessionId ??= identity.sessionId;

		if (this.#sessionId !== identity.sessionId) {
			throw new StaleSandboxHandleError({ operation: 'exec' });
		}

		const snapshot = snapshotRequest(request);
		const settings = operationOptions(options, 'exec');
		const scope = new OperationScope(
			{ operation: 'exec' },
			AbortSignal.any([this.#lifetime.signal, this.#runtimeLifetime]),
			{
				...settings,
				timeoutMs: Math.min(settings.timeoutMs ?? 60_000, 60_000)
			},
			60_000
		);

		try {
			const configured = await boundedApproval(
				scope,
				() => (this.#configured ??= this.#configure(context))
			);
			const decision: unknown = await boundedApproval(scope, () =>
				configured.decide(
					snapshot,
					Object.freeze({ ...scope.context, pi: context })
				)
			);

			const current = inspectContext(context, 'exec');

			if (
				current.sessionId !== identity.sessionId ||
				current.workspace !== identity.workspace
			) {
				throw new StaleSandboxHandleError({ operation: 'exec' });
			}

			if (!isDecision(decision)) {
				throw new ApprovalPolicyError();
			}

			return Object.freeze({
				kind: decision.kind === 'allow' ? 'allow' : 'deny'
			});
		} catch (error) {
			scope.check();

			if (isApprovalError(error) || isSandboxError(error)) {
				throw error;
			}

			throw new ApprovalPolicyError({ cause: error });
		} finally {
			scope.dispose();
		}
	}
}

export function approvalService(pi: SandboxHost): ApprovalServiceV1 {
	if (runtimeSettings(pi).lifetime.aborted) {
		throw new SandboxSessionClosingError({ operation: 'exec' });
	}

	return ensureExtensionService(
		pi.events,
		APPROVAL_SERVICE_CHANNEL,
		isApprovalService,
		(id) => new ApprovalService(id, pi)
	);
}

/**
Obtain a decision for one execution without starting a sandbox or process.
*/
export async function requestExecutionApproval(
	pi: SandboxHost,
	context: ExtensionContext,
	request: ExecutionApprovalRequest,
	options?: SandboxOperationOptions
): Promise<ApprovalDecision> {
	inspectContext(context, 'exec');

	return approvalService(pi).request(context, request, options);
}

export function closeApprovals(pi: SandboxHost): void {
	for (const service of discoverServices(
		pi.events,
		APPROVAL_SERVICE_CHANNEL,
		isApprovalService
	)) {
		service.close();
	}
}
