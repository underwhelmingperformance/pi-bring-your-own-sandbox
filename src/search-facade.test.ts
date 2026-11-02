import { expect, it } from 'vitest';

import { validateBackend } from './backend-validation.js';
import type {
	FindRequest,
	GrepRequest,
	SandboxCapabilities
} from './contracts.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { MemoryBackend } from './fixtures/memory-backend.js';

function fixture(findResult: unknown, grepResult: unknown) {
	const memory = new MemoryBackend('exec');
	const calls: unknown[] = [];
	const capabilities: SandboxCapabilities = {
		processKinds: ['argv'],
		terminationScope: 'workload',
		exitStatus: 'guaranteed',
		operations: ['exec', 'search.find', 'search.grep'],
		shells: []
	};
	const backend = validateBackend(
		{
			id: memory.id,
			workspace: memory.workspace,
			capabilities,
			policy: memory.policy,
			policyDescription: memory.policyDescription,
			recovery: memory.recovery,
			exec: memory.exec.bind(memory),
			dispose: memory.dispose.bind(memory),
			search: {
				find(request: FindRequest) {
					calls.push(request);

					return Promise.resolve(findResult);
				},
				grep(request: GrepRequest) {
					calls.push(request);

					return Promise.resolve(grepResult);
				}
			}
		},
		{
			id: 'fixture',
			label: 'Fixture',
			capabilities,
			policies: {
				workspaceAccess: ['read-write'],
				filesystemScope: ['provider-default'],
				networkAccess: ['provider-default']
			}
		},
		memory.policy
	);
	const owner = new TestBackendOwner(backend);

	return { sandbox: createSandbox(owner), calls, failures: owner.failures };
}

it('snapshots requests, applies defaults and copies structured results', async () => {
	const matches = [
		{ path: 'file', line: 1, text: 'match', before: [], after: [] }
	];
	const paths = ['file'];
	const { sandbox, calls } = fixture(
		{ paths, truncated: false },
		{ matches, truncated: false }
	);
	const request = { pattern: 'original' };
	const find = sandbox.search.find(request);

	request.pattern = 'changed';

	const found = await find;
	const grepped = await sandbox.search.grep({ pattern: 'text' });

	paths[0] = 'changed';
	matches[0] = {
		path: 'changed',
		line: 1,
		text: 'changed',
		before: [],
		after: []
	};
	expect({ found, grepped, calls }).toStrictEqual({
		found: { paths: ['file'], truncated: false },
		grepped: {
			matches: [
				{ path: 'file', line: 1, text: 'match', before: [], after: [] }
			],
			truncated: false
		},
		calls: [
			{ pattern: 'original', limit: 1000 },
			{
				pattern: 'text',
				limit: 100,
				context: 0,
				literal: false,
				ignoreCase: false
			}
		]
	});
});

it.each([
	{ pattern: 'text', path: '../target\0' },
	{ pattern: 'text', limit: 0 },
	{ pattern: 'invalid\0' },
	{ pattern: 'text', unknown: true }
])(
	'rejects invalid find requests before backend invocation: %j',
	async (request) => {
		const { sandbox, calls } = fixture(
			{ paths: [], truncated: false },
			{ matches: [], truncated: false }
		);

		await expect(sandbox.search.find(request)).rejects.toMatchObject({
			name: 'InvalidSandboxRequestError'
		});
		expect(calls).toStrictEqual([]);
	}
);

it('rejects invalid provider results without substituting host search', async () => {
	const { sandbox, calls, failures } = fixture(
		{ paths: ['/host/path'], truncated: false },
		{
			matches: [{ path: 'file', line: 0, text: 'bad', before: [], after: [] }],
			truncated: false
		}
	);

	await expect(sandbox.search.find({ pattern: '*' })).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError'
	});
	await expect(sandbox.search.grep({ pattern: 'text' })).rejects.toMatchObject({
		name: 'InvalidSandboxDeclarationError'
	});
	expect({ calls, failures }).toStrictEqual({
		calls: [
			{ pattern: '*', limit: 1000 },
			{
				pattern: 'text',
				limit: 100,
				context: 0,
				literal: false,
				ignoreCase: false
			}
		],
		failures: []
	});
});
