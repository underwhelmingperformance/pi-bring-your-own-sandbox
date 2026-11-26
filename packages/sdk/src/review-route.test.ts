import { SessionManager } from '@earendil-works/pi-coding-agent';
import { expect, it, vi } from 'vitest';

import type {
	Sandbox,
	SandboxCloseReport,
	SandboxCopyOptions,
	SandboxHost
} from './contracts.js';
import { fixtureEvents } from './fixtures/protocol-peer.js';
import { protocolAddress } from './protocol-address.js';
import { onProtocolRequest, REVIEW_CHANNEL } from './protocol-envelope.js';
import { findReviewRequest } from './protocol-payloads.js';
import { findShellReviewSource, hasShellReviewRoute } from './review-route.js';
import { checker } from './schemas.js';
import { isRecord } from './validation.js';

const isReviewRequest = checker(findReviewRequest);
const call = { toolName: 'bash', toolCallId: 'call-1' };

function host(): SandboxHost {
	return {
		events: fixtureEvents(import.meta.filename),
		on: vi.fn(() => vi.fn()),
		sendMessage: vi.fn(),
		appendEntry: vi.fn(),
		getActiveTools: () => []
	};
}

function context() {
	return {
		cwd: '/project',
		sessionManager: SessionManager.inMemory('/project')
	};
}

/**
A copy as another SDK copy might return it. Its policy allows networking, so
it does not provide `no-network`.
*/
function routedCopy(policy: Sandbox['policy']) {
	const close = vi.fn((): Promise<SandboxCloseReport> =>
		Promise.resolve({ confirmed: true, failures: [], recoveries: [] })
	);
	const sandbox = {
		exec: vi.fn(),
		files: {
			readFile: vi.fn(),
			writeFile: vi.fn(),
			mkdir: vi.fn(),
			access: vi.fn(),
			stat: vi.fn(),
			listDirectory: vi.fn(),
			updateText: vi.fn()
		},
		search: { find: vi.fn(), grep: vi.fn() },
		copy: vi.fn(),
		providerId: 'router',
		backendId: 'copy-1',
		generationId: 'generation',
		workspace: { root: '/copy', pathFlavor: 'posix', relationship: 'copied' },
		policy,
		capabilities: {
			processKinds: ['shell'],
			terminationScope: 'process-group',
			exitStatus: 'guaranteed',
			operations: ['exec', 'files.read'],
			shells: ['sh']
		}
	} as unknown as Sandbox;

	return { close, copy: { sandbox, close } };
}

function answer(
	pi: SandboxHost,
	sessionId: string,
	replies: readonly unknown[],
	isAvailable = true
) {
	const peer = protocolAddress(pi.events);

	onProtocolRequest(pi.events, REVIEW_CHANNEL, peer, 'get-availability', () =>
		isAvailable ? { type: 'available' } : undefined
	);

	for (const source of replies) {
		onProtocolRequest(
			pi.events,
			REVIEW_CHANNEL,
			peer,
			'find-source',
			(request) => {
				const query = request.payload;

				if (
					!isReviewRequest(query) ||
					query.sessionId !== sessionId ||
					query.toolName !== call.toolName ||
					query.toolCallId !== call.toolCallId
				) {
					return;
				}

				return { ...(isRecord(source) && source), type: 'source' };
			}
		);
	}
}

const permissive = {
	hostWorkspaceWrites: false,
	hostUserData: 'denied',
	hostSystemFiles: 'denied',
	network: false
} as const;

it.each([true, false])(
	'reports whether a shell review route answers: %s',
	(isAvailable) => {
		const pi = host();

		answer(pi, 'unused', [], isAvailable);

		expect(hasShellReviewRoute(pi)).toBe(isAvailable);
	}
);

it.each([
	['no reply', []],
	['two replies', [{ copy: vi.fn() }, { copy: vi.fn() }]],
	['a reply without copy', [{ open: vi.fn() }]]
])('finds no review source for %s', (_, replies) => {
	const pi = host();
	const scope = context();

	answer(pi, scope.sessionManager.getSessionId(), replies);

	expect(findShellReviewSource(pi, scope, call)).toBeUndefined();
});

it('checks a routed copy against the options in this SDK copy and closes one that fails', async () => {
	const pi = host();
	const scope = context();
	const routed = routedCopy(permissive);
	const requested: SandboxCopyOptions[] = [];
	const signal = new AbortController().signal;

	answer(pi, scope.sessionManager.getSessionId(), [
		{
			copy: (options: SandboxCopyOptions) => {
				requested.push(options);

				return Promise.resolve(routed.copy);
			}
		}
	]);

	const source = findShellReviewSource(pi, scope, call);

	await expect(
		source?.copy({
			access: { network: 'needed' },
			capabilities: ['exec'],
			signal,
			timeoutMs: 5000
		})
	).rejects.toMatchObject({
		name: 'UnsupportedSandboxPolicyError',
		operation: 'acquire',
		providerId: 'router',
		backendId: 'copy-1'
	});
	expect({ requested, closes: routed.close.mock.calls.length }).toStrictEqual({
		requested: [
			{
				access: { network: 'needed' },
				capabilities: ['exec'],
				signal,
				timeoutMs: 5000
			}
		],
		closes: 1
	});
});

it('returns a routed copy that satisfies the options', async () => {
	const pi = host();
	const scope = context();
	const routed = routedCopy({ ...permissive, network: false });

	answer(pi, scope.sessionManager.getSessionId(), [
		{ copy: () => Promise.resolve(routed.copy) }
	]);

	const copy = await findShellReviewSource(pi, scope, call)?.copy({
		access: { network: 'prevented', hostWorkspaceWrites: 'prevented' },
		shells: ['sh']
	});

	const before = routed.close.mock.calls.length;
	const report = await copy?.close();

	expect({
		sandbox: copy?.sandbox,
		report,
		closes: [before, routed.close.mock.calls.length]
	}).toStrictEqual({
		sandbox: routed.copy.sandbox,
		report: { confirmed: true, failures: [], recoveries: [] },
		closes: [0, 1]
	});
});

it('rejects a routed copy that does not report a copied workspace', async () => {
	const pi = host();
	const scope = context();
	const routed = routedCopy({ ...permissive, network: false });
	const shared = {
		...routed.copy,
		sandbox: {
			...routed.copy.sandbox,
			workspace: { ...routed.copy.sandbox.workspace, relationship: 'shared' }
		}
	};

	answer(pi, scope.sessionManager.getSessionId(), [
		{ copy: () => Promise.resolve(shared) }
	]);

	await expect(
		findShellReviewSource(pi, scope, call)?.copy()
	).rejects.toMatchObject({ name: 'InvalidSandboxDeclarationError' });
	expect(routed.close).toHaveBeenCalledOnce();
});

it('rejects options that select a workspace relationship before asking the route', () => {
	const pi = host();
	const scope = context();
	const copy = vi.fn();

	answer(pi, scope.sessionManager.getSessionId(), [{ copy }]);

	expect(() =>
		findShellReviewSource(pi, scope, call)?.copy({
			workspaceRelationship: 'shared'
		} as SandboxCopyOptions)
	).toThrow(expect.objectContaining({ name: 'InvalidSandboxRequestError' }));
	expect(copy).not.toHaveBeenCalled();
});

it.each([
	['no sandbox', {}],
	['a sandbox without a policy', { sandbox: { providerId: 'router' } }],
	[
		'a sandbox without exec',
		{
			sandbox: {
				...routedCopy(permissive).copy.sandbox,
				exec: undefined
			}
		}
	],
	[
		'files without readFile',
		{
			sandbox: {
				...routedCopy(permissive).copy.sandbox,
				files: {
					...routedCopy(permissive).copy.sandbox.files,
					readFile: undefined
				}
			}
		}
	],
	[
		'search without grep',
		{
			sandbox: {
				...routedCopy(permissive).copy.sandbox,
				search: { find: vi.fn() }
			}
		}
	]
])('closes a routed copy with %s before rejecting it', async (_, malformed) => {
	const pi = host();
	const scope = context();
	const close = vi.fn((): Promise<SandboxCloseReport> =>
		Promise.resolve({ confirmed: true, failures: [], recoveries: [] })
	);

	answer(pi, scope.sessionManager.getSessionId(), [
		{ copy: () => Promise.resolve({ ...malformed, close }) }
	]);

	await expect(
		findShellReviewSource(pi, scope, call)?.copy()
	).rejects.toMatchObject({ name: 'InvalidSandboxDeclarationError' });
	expect(close).toHaveBeenCalledOnce();
});
