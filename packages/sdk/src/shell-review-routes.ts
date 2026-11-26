import { homedir } from 'node:os';

import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';

import { copyHostWorkspace, getSandbox } from './client.js';
import type { Sandbox, SandboxCopy, SandboxCopyOptions } from './contracts.js';
import {
	InvalidSandboxRequestError,
	StaleSandboxHandleError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import type { EscalationDecision } from './escalation-ledger.js';
import { appendLedgerEntry } from './escalation-ledger.js';
import { boundedApproval } from './execution-approval.js';
import { OperationScope } from './lifecycle.js';
import { unrestrictedPolicy } from './policy-model.js';
import { protocolAddress } from './protocol-address.js';
import { onProtocolRequest, REVIEW_CHANNEL } from './protocol-envelope.js';
import { findReviewRequest, sourceReply } from './protocol-payloads.js';
import { projectReply } from './protocol-version.js';
import { runtimeSettings } from './runtime-settings.js';
import {
	checkCopiedSandbox,
	copyOptions,
	rethrowCopyError
} from './sandbox-copy.js';
import { checker } from './schemas.js';
import {
	effectiveCommand,
	escalationInput,
	PendingEscalation
} from './shell-escalation.js';
import { isRecord } from './validation.js';

type BoundDestination =
	{ kind: 'host' } | { kind: 'sandbox'; sandbox: Sandbox };

interface Route {
	readonly context: ExtensionContext;
	readonly command: string;
	readonly prefix: string | undefined;
	readonly isOutside: boolean;
	readonly escalation?: PendingEscalation;
	destination?: BoundDestination;
}

const isReviewQuery = checker(findReviewRequest);

export class ShellReviewRoutes {
	readonly #routes = new Map<string, Route>();

	constructor(
		pi: ExtensionAPI,
		toolName: 'bash' | 'powershell',
		isSelected: () => boolean
	) {
		pi.on('tool_execution_start', async (event, context) => {
			if (event.toolName !== toolName || !isSelected()) {
				return;
			}

			const input: unknown = event.args;

			if (!isRecord(input) || typeof input['command'] !== 'string') {
				return;
			}

			const prefix =
				toolName === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
			const requested = escalationInput(
				event.toolCallId,
				effectiveCommand(input['command'], prefix),
				{ escalate: input['escalate'], justification: input['justification'] }
			);
			const escalation =
				requested === undefined
					? undefined
					: new PendingEscalation(pi, context, requested);

			this.#routes.set(event.toolCallId, {
				context,
				command: input['command'],
				prefix,
				isOutside: input['execution'] === 'outside-sandbox',
				...(escalation !== undefined && { escalation })
			});
			await escalation?.prepare(toolName);
		});

		const local = protocolAddress(pi.events);

		onProtocolRequest(
			pi.events,
			REVIEW_CHANNEL,
			local,
			'get-availability',
			() => (isSelected() ? { type: 'available' } : undefined)
		);

		onProtocolRequest(
			pi.events,
			REVIEW_CHANNEL,
			local,
			'find-source',
			(request) => {
				const message = request.payload;

				if (!isReviewQuery(message) || message.toolName !== toolName) {
					return;
				}

				const id = message.toolCallId;
				const route = this.#routes.get(id);

				if (
					route === undefined ||
					route.context.sessionManager.getSessionId() !== message.sessionId ||
					!isSelected()
				) {
					return;
				}

				const isCurrent = () => this.#routes.get(id) === route && isSelected();
				const pending = route.escalation;
				const escalation = pending?.request;

				return projectReply(
					sourceReply,
					{
						type: 'source',
						copy: (options?: SandboxCopyOptions) =>
							this.#copy(pi, route, options, isCurrent, {
								id,
								extension: request.extensionSource
							}),
						...(pending !== undefined &&
							escalation !== undefined && {
								escalation,
								recordDecision: (decision: EscalationDecision) => {
									if (!isCurrent()) {
										throw new InvalidSandboxRequestError({ operation: 'exec' });
									}

									pending.record(decision, request.extensionSource);
								}
							})
					},
					local,
					request
				);
			}
		);

		pi.on('tool_result', (event) => {
			if (event.toolName !== toolName) {
				return;
			}

			this.#routes.get(event.toolCallId)?.escalation?.finish();
			this.#routes.delete(event.toolCallId);
		});
		pi.on('turn_end', () => {
			this.#clear();
		});
		pi.on('session_shutdown', () => {
			this.#clear();
		});
	}

	#clear(): void {
		for (const route of this.#routes.values()) {
			route.escalation?.finish();
		}

		this.#routes.clear();
	}

	async #copy(
		pi: ExtensionAPI,
		route: Route,
		input: SandboxCopyOptions | undefined,
		isCurrent: () => boolean,
		reviewer: { readonly id: string; readonly extension: string }
	): Promise<SandboxCopy> {
		const options = copyOptions(input);
		const signal = options.signal;
		const check = () => {
			signal?.throwIfAborted();

			if (!isCurrent()) {
				throw new StaleSandboxHandleError({ operation: 'acquire' });
			}
		};

		check();

		const settings = runtimeSettings(pi);
		const scope = new OperationScope(
			{ operation: 'acquire' },
			settings.lifetime,
			options,
			60_000
		);
		let destination: BoundDestination;
		let copying: Promise<SandboxCopy>;

		try {
			destination = await boundedApproval(scope, () =>
				this.#destination(pi, route, scope)
			);
			check();
			copying = this.#copyDestination(pi, route, destination, {
				...options,
				timeoutMs: scope.remainingMs
			});
		} finally {
			scope.dispose();
		}

		const copy = await copying;

		try {
			check();
			checkCopiedSandbox(copy.sandbox, options);

			const previous = route.destination;

			if (
				previous?.kind === 'sandbox' &&
				destination.kind === 'sandbox' &&
				(previous.sandbox.generationId !== destination.sandbox.generationId ||
					previous.sandbox.backendId !== destination.sandbox.backendId ||
					previous.sandbox.providerId !== destination.sandbox.providerId)
			) {
				throw new StaleSandboxHandleError({ operation: 'acquire' });
			}

			route.destination = destination;

			const sandbox =
				destination.kind === 'sandbox' ? destination.sandbox : undefined;

			appendLedgerEntry(pi, {
				kind: 'review-copy',
				toolCallId: reviewer.id,
				source:
					sandbox === undefined
						? {
								providerId: 'passthrough',
								label: 'Host checkout',
								policy: unrestrictedPolicy,
								workspace: {
									root: route.context.cwd,
									home: homedir(),
									pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
									relationship: 'shared',
									description: 'The host checkout.'
								}
							}
						: {
								providerId: sandbox.providerId,
								label: sandbox.providerId,
								policy: sandbox.policy,
								workspace: sandbox.workspace
							},
				policy: copy.sandbox.policy,
				decider: { kind: 'permission-extension', extension: reviewer.extension }
			});

			return copy;
		} catch (error) {
			return rethrowCopyError(error, () => copy.close(), {
				operation: 'dispose',
				providerId: copy.sandbox.providerId,
				backendId: copy.sandbox.backendId
			});
		}
	}

	async #destination(
		pi: ExtensionAPI,
		route: Route,
		scope: OperationScope
	): Promise<BoundDestination> {
		if (route.escalation !== undefined) {
			if (route.escalation.request === undefined) {
				throw new InvalidSandboxRequestError({ operation: 'acquire' });
			}

			return { kind: 'host' };
		}

		if (!route.isOutside) {
			const sandbox = await getSandbox(pi, route.context, {
				signal: scope.context.signal,
				timeoutMs: scope.remainingMs
			});

			return { kind: 'sandbox', sandbox };
		}

		const settings = runtimeSettings(pi);
		const config = await settings.read(route.context);

		if (
			config.outsideSandbox?.destination === 'provider' ||
			settings.normalExecutor !== undefined
		) {
			throw new UnsupportedSandboxCapabilityError({ operation: 'acquire' });
		}

		return { kind: 'host' };
	}

	#copyDestination(
		pi: ExtensionAPI,
		route: Route,
		destination: BoundDestination,
		options: SandboxCopyOptions
	): Promise<SandboxCopy> {
		return destination.kind === 'sandbox'
			? destination.sandbox.copy(options)
			: copyHostWorkspace(pi, route.context, options);
	}

	executing(
		id: string,
		command: string,
		prefix: string | undefined,
		isOutside: boolean
	): BoundDestination | undefined {
		const route = this.#routes.get(id);

		if (route?.destination === undefined) {
			return;
		}

		if (
			route.command !== command ||
			route.prefix !== prefix ||
			route.isOutside !== isOutside
		) {
			throw new StaleSandboxHandleError({ operation: 'exec' });
		}

		return route.destination;
	}

	escalation(id: string): PendingEscalation | undefined {
		return this.#routes.get(id)?.escalation;
	}
}
