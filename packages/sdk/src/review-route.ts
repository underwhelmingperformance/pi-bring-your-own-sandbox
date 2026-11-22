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
import { copyOptions, rethrowCopyError } from './sandbox-copy.js';
import { isRecord } from './validation.js';

export const SHELL_REVIEW_CHANNEL = 'pi-byos:review:tool-call:v2';

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
		rethrowCopyError(
			new InvalidSandboxDeclarationError({ operation: 'acquire' }),
			await copy.close(),
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
		rethrowCopyError(error, await copy.close(), {
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
	let isAvailable = false;

	pi.events.emit(SHELL_REVIEW_CHANNEL, {
		kind: 'available',
		reply: () => {
			isAvailable = true;
		}
	});

	return isAvailable;
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

	const routes: ShellReviewSource[] = [];

	pi.events.emit(SHELL_REVIEW_CHANNEL, {
		sessionId: context.sessionManager.getSessionId(),
		toolName: call.toolName,
		toolCallId: call.toolCallId,
		reply: (source: unknown) => {
			if (isRecord(source) && typeof source['copy'] === 'function') {
				routes.push(source as unknown as ShellReviewSource);
			}
		}
	});

	const [route] = routes;

	if (route === undefined || routes.length !== 1) {
		return undefined;
	}

	return Object.freeze({
		copy: (options?: SandboxCopyOptions) => checkedCopy(route, options)
	});
}
