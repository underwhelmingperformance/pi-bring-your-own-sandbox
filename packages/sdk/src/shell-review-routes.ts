import type {
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionStartEvent
} from '@earendil-works/pi-coding-agent';

import type { BrokerReviewRegistration } from './broker-review.js';
import { ensureSandboxService } from './default-broker.js';
import {
	InvalidSandboxRequestError,
	isSandboxError,
	StaleSandboxHandleError
} from './errors.js';
import { protocolAddress } from './protocol-address.js';
import { onProtocolRequest, REVIEW_CHANNEL } from './protocol-envelope.js';
import { findReviewRequest, sourceReply } from './protocol-payloads.js';
import { projectReply } from './protocol-version.js';
import type { ReviewUnavailableReason } from './review-identities.js';
import { checker } from './schemas.js';
import {
	effectiveCommand,
	escalationInput,
	PendingEscalation
} from './shell-escalation.js';
import { isRecord } from './validation.js';

interface Route {
	readonly context: ExtensionContext;
	readonly command: string;
	readonly prefix: string | undefined;
	readonly escalation?: PendingEscalation;
	registration?: BrokerReviewRegistration;
}

const isReviewQuery = checker(findReviewRequest);

export class ShellReviewRoutes {
	readonly #routes = new Map<string, Route>();

	constructor(
		pi: ExtensionAPI,
		toolName: 'bash' | 'powershell',
		isSelected: () => boolean
	) {
		const isActive = () =>
			isSelected() && pi.getActiveTools().includes(toolName);

		pi.on('tool_execution_start', async (event, context) => {
			if (event.toolName !== toolName || !isActive()) {
				return;
			}

			await this.#prepare(pi, event, context, toolName, isActive);
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
				const unavailable = (reason: ReviewUnavailableReason) =>
					projectReply(
						sourceReply,
						{ type: 'source', ok: false, toolCallId: id, reason },
						local,
						request
					);

				if (!isActive()) {
					return unavailable('not-selected');
				}

				if (
					route === undefined ||
					route.context.sessionManager.getSessionId() !== message.sessionId
				) {
					return unavailable('unknown-call');
				}

				if (route.registration === undefined) {
					return unavailable('destination-unavailable');
				}

				const { requestId, extensionSource } = request;
				const sourceId = route.registration.issue({
					toolName: message.toolName,
					toolCallId: id,
					sessionId: message.sessionId,
					requestId,
					extensionSource
				});

				return sourceId === undefined
					? unavailable('invalid-source')
					: projectReply(
							sourceReply,
							{ type: 'source', ok: true, toolCallId: id, sourceId },
							local,
							request
						);
			}
		);

		pi.on('tool_result', (event) => {
			if (event.toolName === toolName) {
				this.#delete(event.toolCallId);
			}
		});
		pi.on('turn_end', () => {
			this.#clear();
		});
		pi.on('session_shutdown', () => {
			this.#clear();
		});
	}

	async #prepare(
		pi: ExtensionAPI,
		event: ToolExecutionStartEvent,
		context: ExtensionContext,
		dialect: 'bash' | 'powershell',
		isActive: () => boolean
	): Promise<void> {
		const id = event.toolCallId;
		const previous = this.#routes.get(id);

		if (previous !== undefined) {
			this.#revoke(previous);

			return;
		}

		const input: unknown = event.args;

		if (!isRecord(input) || typeof input['command'] !== 'string') {
			return;
		}

		const command = input['command'];
		const prefix =
			dialect === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
		let requested: ReturnType<typeof escalationInput>;

		try {
			requested = escalationInput(id, effectiveCommand(command, prefix), {
				escalate: input['escalate'],
				justification: input['justification']
			});
		} catch (error) {
			if (isSandboxError(error, InvalidSandboxRequestError)) {
				return;
			}

			throw error;
		}

		const escalation =
			requested === undefined
				? undefined
				: new PendingEscalation(pi, context, requested);
		const route: Route = {
			context,
			command,
			prefix,
			...(escalation !== undefined && { escalation })
		};

		this.#routes.set(id, route);
		await escalation?.prepare(dialect);

		const call = { toolName: dialect, toolCallId: id };
		const isCurrent = () => this.#routes.get(id) === route && isActive();
		const request = escalation?.request;

		if (!isCurrent() || (escalation !== undefined && request === undefined)) {
			return;
		}

		try {
			const broker = ensureSandboxService(pi);
			const registration = await broker.prepareReview?.(context, {
				call,
				...(escalation !== undefined &&
					request !== undefined && {
						escalation: request,
						decisionDeadline: escalation.decisionDeadline
					})
			});

			if (registration === undefined) {
				return;
			}

			if (!isCurrent()) {
				registration.revoke();

				return;
			}

			route.registration = registration;
			escalation?.bindReview(registration);
		} catch (error) {
			if (!isSandboxError(error)) {
				throw error;
			}
		}
	}

	#revoke(route: Route): void {
		route.registration?.revoke();
		route.escalation?.finish();
	}

	#delete(id: string): void {
		const route = this.#routes.get(id);

		if (route === undefined) {
			return;
		}

		this.#routes.delete(id);
		this.#revoke(route);
	}

	#clear(): void {
		for (const id of this.#routes.keys()) {
			this.#delete(id);
		}
	}

	verifyExecution(
		id: string,
		command: string,
		prefix: string | undefined
	): void {
		const route = this.#routes.get(id);

		if (
			route?.registration?.isReviewed() === true &&
			(route.command !== command || route.prefix !== prefix)
		) {
			throw new StaleSandboxHandleError({ operation: 'exec' });
		}
	}

	escalation(id: string): PendingEscalation | undefined {
		return this.#routes.get(id)?.escalation;
	}
}
