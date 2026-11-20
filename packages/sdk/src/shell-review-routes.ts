import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';

import { getSandbox } from './client.js';
import type { ReviewSnapshot, Sandbox } from './contracts.js';
import {
	StaleSandboxHandleError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { boundedApproval } from './execution-approval.js';
import { OperationScope } from './lifecycle.js';
import { rethrowSnapshotError } from './review-requirements.js';
import { openReviewSnapshot } from './review-snapshot.js';
import { runtimeSettings } from './runtime-settings.js';
import { isRecord } from './validation.js';

const channel = 'pi-byos:review:tool-call:v1';

type BoundDestination =
	{ kind: 'host' } | { kind: 'sandbox'; sandbox: Sandbox };

interface Route {
	readonly context: ExtensionContext;
	readonly command: string;
	readonly isOutside: boolean;
	destination?: BoundDestination;
}

function isAvailabilityQuery(
	message: unknown
): message is { kind: 'available'; reply: () => void } {
	return (
		isRecord(message) &&
		message['kind'] === 'available' &&
		typeof message['reply'] === 'function'
	);
}

interface ReviewQuery {
	readonly toolName: string;
	readonly toolCallId: string;
	readonly sessionId: string;
	readonly reply: (
		open: (signal: AbortSignal) => Promise<ReviewSnapshot>
	) => void;
}

function isReviewQuery(message: unknown): message is ReviewQuery {
	return (
		isRecord(message) &&
		typeof message['toolName'] === 'string' &&
		typeof message['toolCallId'] === 'string' &&
		typeof message['sessionId'] === 'string' &&
		typeof message['reply'] === 'function'
	);
}

export class ShellReviewRoutes {
	readonly #routes = new Map<string, Route>();

	constructor(pi: ExtensionAPI, toolName: string, isSelected: () => boolean) {
		pi.on('tool_call', (event, context) => {
			if (event.toolName !== toolName || !isSelected()) {
				return;
			}

			const input: unknown = event.input;

			if (!isRecord(input) || typeof input['command'] !== 'string') {
				return;
			}

			this.#routes.set(event.toolCallId, {
				context,
				command: input['command'],
				isOutside: input['execution'] === 'outside-sandbox'
			});
		});
		pi.events.on(channel, (message: unknown) => {
			if (isAvailabilityQuery(message)) {
				if (isSelected()) {
					message.reply();
				}

				return;
			}

			if (!isReviewQuery(message) || message.toolName !== toolName) {
				return;
			}

			const id = message.toolCallId;
			const route = this.#routes.get(id);

			if (
				!route ||
				route.context.sessionManager.getSessionId() !== message.sessionId ||
				!isSelected()
			) {
				return;
			}

			message.reply((signal) =>
				this.#open(
					pi,
					route,
					signal,
					() => this.#routes.get(id) === route && isSelected()
				)
			);
		});

		pi.on('tool_result', (event) => {
			if (event.toolName === toolName) {
				this.#routes.delete(event.toolCallId);
			}
		});
		pi.on('turn_end', () => {
			this.#routes.clear();
		});
		pi.on('session_shutdown', () => {
			this.#routes.clear();
		});
	}

	async #open(
		pi: ExtensionAPI,
		route: Route,
		signal: AbortSignal,
		isCurrent: () => boolean
	): Promise<ReviewSnapshot> {
		const check = () => {
			signal.throwIfAborted();

			if (!isCurrent()) {
				throw new StaleSandboxHandleError({ operation: 'acquire' });
			}
		};

		check();

		let destination: BoundDestination;

		if (route.isOutside) {
			const settings = runtimeSettings(pi);
			const scope = new OperationScope(
				{ operation: 'acquire' },
				settings.lifetime,
				{ signal },
				60_000
			);

			try {
				const config = await boundedApproval(scope, () =>
					settings.read(route.context)
				);

				if (
					config.outsideSandbox?.destination === 'provider' ||
					settings.normalExecutor !== undefined
				) {
					throw new UnsupportedSandboxCapabilityError({ operation: 'acquire' });
				}
			} finally {
				scope.dispose();
			}

			destination = { kind: 'host' };
		} else {
			const sandbox = await getSandbox(pi, route.context, { signal });

			destination = { kind: 'sandbox', sandbox };
		}

		check();

		const source =
			destination.kind === 'host'
				? destination
				: {
						kind: 'sandbox' as const,
						generationId: destination.sandbox.generationId,
						backendId: destination.sandbox.backendId,
						providerId: destination.sandbox.providerId
					};

		const snapshot = await openReviewSnapshot(pi, route.context, source, {
			signal
		});

		try {
			check();

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

			return snapshot;
		} catch (error) {
			rethrowSnapshotError(error, await snapshot.close(), {
				operation: 'dispose',
				providerId: snapshot.sandbox.providerId,
				backendId: snapshot.sandbox.backendId
			});
		}
	}

	executing(
		id: string,
		command: string,
		isOutside: boolean
	): BoundDestination | undefined {
		const route = this.#routes.get(id);

		if (route?.destination === undefined) {
			return;
		}

		if (route.command !== command || route.isOutside !== isOutside) {
			throw new StaleSandboxHandleError({ operation: 'exec' });
		}

		return route.destination;
	}
}
