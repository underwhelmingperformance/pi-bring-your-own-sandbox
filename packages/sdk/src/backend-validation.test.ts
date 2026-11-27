import path from 'node:path';

import { expect, it } from 'vitest';

import { validateBackend, verifyGrantedPaths } from './backend-validation.js';
import { InvalidSandboxDeclarationError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { OperationScope } from './lifecycle.js';

const provider = {
	id: 'fixture',
	protocol: {
		extensionSource: '/fixture.ts',
		packageVersion: '1.0.0',
		buildId: 'fixture',
		major: 1,
		featureLevel: 0
	}
};

it.each(['posix', 'win32'] as const)(
	'validates an exact %s profile and workspace',
	(pathFlavor) => {
		const backend = new MemoryBackend();
		const workspace = {
			...backend.workspace,
			pathFlavor,
			root: pathFlavor === 'posix' ? '/fixture' : 'C:\\fixture'
		};
		const value = Object.assign(backend, { workspace });

		expect(validateBackend(value, provider, backend.profile)).toBe(value);
	}
);

it.each([
	{
		label: 'policy',
		override: { policy: { ...new MemoryBackend().policy, network: true } }
	},
	{ label: 'capabilities', override: { capabilities: [] } },
	{
		label: 'shells',
		override: { processKinds: ['argv', 'shell'], shells: ['bash'] }
	},
	{ label: 'exit status', override: { exitStatus: 'optional' } },
	{
		label: 'termination scope',
		override: { terminationScope: 'process-group' }
	}
])('refuses a backend with different $label', ({ override }) => {
	const backend = new MemoryBackend();
	const declared = {
		...backend.profile,
		...override
	} as typeof backend.profile;

	expect(() => validateBackend(backend, provider, declared)).toThrow(
		InvalidSandboxDeclarationError
	);
});

it('rejects a workspace relationship that differs from the selected operation', () => {
	const backend = new MemoryBackend();

	expect(() =>
		validateBackend(backend, provider, backend.profile, 'copy')
	).toThrow(InvalidSandboxDeclarationError);
});

it.each([
	{ label: 'invalid exec', malformed: { exec: undefined } },
	{ label: 'invalid disposal', malformed: { dispose: 'dispose' } },
	{ label: 'missing advertised file groups', malformed: { files: undefined } }
])('rejects $label', ({ malformed }) => {
	const backend = new MemoryBackend();
	const required = backend.profile;

	expect(() =>
		validateBackend(Object.assign(backend, malformed), provider, required)
	).toThrow(InvalidSandboxDeclarationError);
});

it.each([
	{
		case: 'refuses a different workspace file',
		flavor: 'posix',
		file: 'other.txt',
		supportsRead: true,
		isReachable: false
	},
	{
		case: 'refuses a workspace grant without a probe',
		flavor: 'posix',
		file: 'requested.txt',
		supportsRead: false,
		isReachable: false
	},
	{
		case: 'uses the target path flavour for a nested workspace grant',
		flavor: 'win32',
		file: 'requested.txt',
		supportsRead: true,
		isReachable: true
	}
] as const)('$case', async ({ flavor, file, supportsRead, isReachable }) => {
	const checkout = path.resolve('/host/checkout');
	const hostPath = path.join(checkout, 'nested', 'requested.txt');
	const backend = new MemoryBackend(supportsRead ? 'files' : 'exec');
	const root = flavor === 'posix' ? backend.workspace.root : 'C:\\fixture';
	const targetPath = path[flavor].join(root, 'nested', file);
	const scope = new OperationScope(
		{ operation: 'open' },
		new AbortController().signal,
		{},
		60_000
	);

	Object.assign(backend, {
		workspace: { ...backend.workspace, root, pathFlavor: flavor },
		grantedPaths: [{ kind: 'read' as const, hostPath, targetPath }]
	});
	backend.seed(targetPath, new Uint8Array([1]));

	try {
		const result = verifyGrantedPaths(
			backend,
			[{ kind: 'read', path: hostPath, location: 'workspace' }],
			scope.context,
			provider,
			checkout
		);

		if (isReachable) {
			await expect(result).resolves.toBeUndefined();

			return;
		}

		await expect(result).rejects.toMatchObject({
			name: 'UnsupportedSandboxPolicyError',
			providerId: provider.id,
			detail: {
				kind: 'path',
				access: 'read',
				path: hostPath,
				reason: 'unreachable'
			}
		});
	} finally {
		scope.dispose();
	}
});
