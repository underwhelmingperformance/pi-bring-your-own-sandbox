import { expect, it } from 'vitest';

import { validateBackend } from './backend-validation.js';
import { InvalidSandboxDeclarationError } from './errors.js';
import { MemoryBackend } from './fixtures/memory-backend.js';

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
	{ label: 'capabilities', override: { capabilities: ['exec'] } },
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
