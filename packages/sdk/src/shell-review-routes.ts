import { isDeepStrictEqual } from 'node:util';

import type {
	ExtensionAPI,
	ExtensionContext,
	ToolExecutionStartEvent
} from '@earendil-works/pi-coding-agent';
import type { TSchema } from 'typebox';

import type { SandboxBroker } from './broker.js';
import type { BrokerReviewRegistration } from './broker-review.js';
import type { SandboxSession } from './context.js';
import type { SandboxOperationOptions } from './contracts.js';
import {
	InvalidSandboxRequestError,
	isSandboxError,
	StaleSandboxHandleError
} from './errors.js';
import type { EscalatedSandbox } from './escalation-plan.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { onProtocolRequest, REVIEW_CHANNEL } from './protocol-envelope.js';
import { findReviewRequest, sourceReply } from './protocol-payloads.js';
import { projectReply } from './protocol-version.js';
import type { ReviewUnavailableReason } from './review-identities.js';
import type { ShellSettings } from './runtime-participant.js';
import { checker } from './schemas.js';
import {
	effectiveCommand,
	escalationInput,
	PendingEscalation
} from './shell-escalation.js';
import { isRecord } from './validation.js';

type Dialect = 'bash' | 'powershell';

interface ShellCommand {
	readonly command: string;
	readonly prefix: string | undefined;
	readonly timeout: number | undefined;
	readonly escalation: ReturnType<typeof escalationInput>;
}

interface Route {
	readonly command: ShellCommand;
	readonly pending: PendingEscalation | undefined;
	isClaimed: boolean;
	registration?: BrokerReviewRegistration;
}

interface ShellDispatch {
	readonly prefix: string | undefined;
	readonly open?: (
		command: string,
		options: SandboxOperationOptions
	) => Promise<EscalatedSandbox>;
	readonly finish: () => void;
}

export type ClaimShellCall = (
	id: string,
	input: unknown,
	context: ExtensionContext
) => ShellDispatch;

export interface ShellRouteRegistration {
	readonly pi: ExtensionAPI;
	readonly toolName: Dialect;
	readonly identity: ProtocolIdentity;
	readonly parameters: TSchema;
	readonly receive: (claim: ClaimShellCall) => void;
}

const isReviewQuery = checker(findReviewRequest);

export class ShellReviewRoutes {
	readonly #routes = new Map<string, Route>();
	readonly #registration: ShellRouteRegistration;
	readonly #broker: SandboxBroker;
	readonly #session: SandboxSession;
	readonly #settings: ShellSettings;
	readonly #isInput: (input: unknown) => boolean;

	constructor(
		registration: ShellRouteRegistration,
		broker: SandboxBroker,
		session: SandboxSession,
		settings: ShellSettings
	) {
		this.#registration = registration;
		this.#broker = broker;
		this.#session = session;
		this.#settings = settings;
		this.#isInput = checker(registration.parameters);

		const { pi, toolName } = registration;

		pi.on('tool_execution_start', async (event, context) => {
			if (event.toolName === toolName && this.#isActive()) {
				await this.#prepare(event, context);
			}
		});

		const local = registration.identity;

		onProtocolRequest(
			pi.events,
			REVIEW_CHANNEL,
			local,
			'get-availability',
			() => (this.#isSelected() ? { type: 'available' } : undefined)
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

				if (!this.#isActive()) {
					return unavailable('not-selected');
				}

				if (
					route === undefined ||
					message.sessionId !== this.#session.sessionId
				) {
					return unavailable('unknown-call');
				}

				if (route.registration === undefined) {
					return unavailable('destination-unavailable');
				}

				const sourceId = route.registration.issue({
					toolName,
					toolCallId: id,
					sessionId: message.sessionId,
					requestId: request.requestId,
					extensionSource: request.extensionSource
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

		pi.on('tool_execution_end', (event) => {
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

	#isSelected(): boolean {
		const { pi, toolName, parameters, identity } = this.#registration;

		return pi
			.getAllTools()
			.some(
				(tool) =>
					tool.name === toolName &&
					tool.sourceInfo.path === identity.extensionSource &&
					tool.parameters === parameters
			);
	}

	#isActive(): boolean {
		const { pi, toolName } = this.#registration;

		return this.#isSelected() && pi.getActiveTools().includes(toolName);
	}

	#read(id: string, input: unknown): ShellCommand {
		if (
			!isRecord(input) ||
			typeof input['command'] !== 'string' ||
			!this.#isInput(input)
		) {
			throw new InvalidSandboxRequestError({ operation: 'exec' });
		}

		const { pi, toolName } = this.#registration;
		const command = input['command'];
		const prefix =
			toolName === 'bash' ? pi.getSettings().shellCommandPrefix : undefined;
		const escalation = escalationInput(id, effectiveCommand(command, prefix), {
			escalate: input['escalate'],
			justification: input['justification']
		});

		if (escalation === undefined && input['justification'] !== undefined) {
			throw new InvalidSandboxRequestError({
				operation: 'exec',
				detail: { kind: 'request', field: 'justification' }
			});
		}

		return Object.freeze({
			command,
			prefix,
			timeout:
				typeof input['timeout'] === 'number' ? input['timeout'] : undefined,
			escalation
		});
	}

	async #prepare(
		event: ToolExecutionStartEvent,
		context: ExtensionContext
	): Promise<void> {
		this.#session.check(context, 'exec');

		const id = event.toolCallId;
		const previous = this.#routes.get(id);

		if (previous !== undefined) {
			previous.isClaimed = true;
			this.#revoke(previous);

			return;
		}

		let command: ShellCommand;

		try {
			command = this.#read(id, event.args);
		} catch (error) {
			if (isSandboxError(error, InvalidSandboxRequestError)) {
				return;
			}

			throw error;
		}

		const { pi, toolName } = this.#registration;
		const pending =
			command.escalation === undefined
				? undefined
				: new PendingEscalation(
						pi,
						context,
						command.escalation,
						this.#settings,
						this.#broker
					);
		const route: Route = { command, pending, isClaimed: false };

		this.#routes.set(id, route);
		await pending?.prepare(toolName);

		const isCurrent = () =>
			this.#routes.get(id) === route && !route.isClaimed && this.#isActive();

		if (
			!isCurrent() ||
			(pending !== undefined && pending.request === undefined)
		) {
			return;
		}

		try {
			const registration = await this.#broker.prepareReview(
				context,
				{ toolName, toolCallId: id },
				pending
			);

			if (!isCurrent()) {
				registration.revoke();

				return;
			}

			route.registration = registration;
			pending?.bindReview(registration);
		} catch (error) {
			if (!isSandboxError(error)) {
				throw error;
			}
		}
	}

	#revoke(route: Route): void {
		route.registration?.revoke();
		route.pending?.finish();
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

	claim(id: string, input: unknown, context: ExtensionContext): ShellDispatch {
		this.#session.check(context, 'exec');

		const command = this.#read(id, input);
		const route = this.#routes.get(id);

		if (route === undefined || route.isClaimed) {
			throw new StaleSandboxHandleError({ operation: 'exec' });
		}

		if (!this.#isActive() || !isDeepStrictEqual(route.command, command)) {
			route.pending?.invalidate();
			this.#delete(id);

			throw new StaleSandboxHandleError({ operation: 'exec' });
		}

		route.isClaimed = true;

		const pending = route.pending;

		return Object.freeze<ShellDispatch>({
			prefix: route.command.prefix,
			...(pending !== undefined && {
				open: (effective, options) => pending.open(context, effective, options)
			}),
			finish: () => {
				this.#delete(id);
			}
		});
	}
}
