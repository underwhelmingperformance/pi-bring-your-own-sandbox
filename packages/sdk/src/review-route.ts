import { checkRequirements } from './acquire-options.js';
import { inspectContext } from './context.js';
import type {
	ReviewedToolCall,
	Sandbox,
	SandboxContext,
	SandboxCopy,
	SandboxCopyOptions,
	SandboxHost,
	ShellReviewSource
} from './contracts.js';
import { InvalidSandboxDeclarationError } from './errors.js';
import { protocolAddress } from './protocol-address.js';
import { collectProtocolReplies, REVIEW_CHANNEL } from './protocol-envelope.js';
import { copyOptionsSchema, sourceReply } from './protocol-payloads.js';
import { checkDemand, sharedFeatureLevel } from './protocol-version.js';
import { copyOptions, rethrowCopyError } from './sandbox-copy.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

const isSource = checker(sourceReply);

function isClosable(
	value: unknown
): value is Record<string, unknown> & Pick<SandboxCopy, 'close'> {
	return isRecord(value) && typeof value['close'] === 'function';
}

const FILE_METHODS = [
	'readFile',
	'writeFile',
	'mkdir',
	'access',
	'stat',
	'listDirectory',
	'updateText'
] as const;
const SEARCH_METHODS = ['find', 'grep'] as const;

function hasMethods(value: unknown, names: readonly string[]): boolean {
	return (
		isRecord(value) && names.every((name) => typeof value[name] === 'function')
	);
}

function isSandbox(value: unknown): value is Sandbox {
	return (
		isRecord(value) &&
		typeof value['providerId'] === 'string' &&
		typeof value['backendId'] === 'string' &&
		isRecord(value['workspace']) &&
		isRecord(value['policy']) &&
		isRecord(value['capabilities']) &&
		hasMethods(value, ['exec', 'copy']) &&
		hasMethods(value['files'], FILE_METHODS) &&
		hasMethods(value['search'], SEARCH_METHODS)
	);
}

async function checkedCopy(
	route: ShellReviewSource,
	input: SandboxCopyOptions | undefined
): Promise<SandboxCopy> {
	const options = copyOptions(input);
	const copy: unknown = await route.copy(options);

	if (!isClosable(copy)) {
		throw new InvalidSandboxDeclarationError({ operation: 'acquire' });
	}

	const { sandbox } = copy;

	if (!isSandbox(sandbox)) {
		return rethrowCopyError(
			new InvalidSandboxDeclarationError({ operation: 'acquire' }),
			() => copy.close(),
			{ operation: 'dispose' }
		);
	}

	try {
		checkRequirements(sandbox, {
			...options,
			workspaceRelationship: 'copied'
		});

		return { sandbox, close: () => copy.close() };
	} catch (error) {
		return rethrowCopyError(error, () => copy.close(), {
			operation: 'dispose',
			providerId: sandbox.providerId,
			backendId: sandbox.backendId
		});
	}
}

/**
Whether a loaded BYOS shell extension answers review queries. A route can still
decline a particular call.
*/
export function hasShellReviewRoute(pi: SandboxHost): boolean {
	const local = protocolAddress(pi.events);

	return collectProtocolReplies(pi.events, REVIEW_CHANNEL, local, {
		type: 'get-availability'
	}).some((reply) => {
		sharedFeatureLevel(local, reply);

		return reply.kind === 'reply' && reply.payload.type === 'available';
	});
}

/**
Find the destination of a shell tool call while it is pending, for example from
a permission gate's `tool_call` handler. Returns `undefined` unless exactly one
BYOS shell route claims the call.

The route may come from another SDK installation. The returned source checks
each copy against the caller's options in this SDK, as `getSandbox` does for a
shared sandbox, and closes a copy that fails the check.
*/
export function findShellReviewSource(
	pi: SandboxHost,
	context: SandboxContext,
	call: ReviewedToolCall
): ShellReviewSource | undefined {
	inspectContext(context, 'acquire');

	const local = protocolAddress(pi.events);
	const routes = collectProtocolReplies(pi.events, REVIEW_CHANNEL, local, {
		type: 'find-source',
		sessionId: context.sessionManager.getSessionId(),
		toolName: call.toolName,
		toolCallId: call.toolCallId
	}).filter((reply) => {
		sharedFeatureLevel(local, reply);

		return reply.kind === 'reply' && isSource(reply.payload);
	});
	const [selected] = routes;

	if (
		selected === undefined ||
		routes.length !== 1 ||
		!isSource(selected.payload)
	) {
		return undefined;
	}

	const route = selected.payload;

	return Object.freeze<ShellReviewSource>({
		copy(options) {
			checkDemand(
				copyOptionsSchema,
				options ?? {},
				local,
				selected,
				'review copy'
			);

			return checkedCopy(route, options);
		}
	});
}
