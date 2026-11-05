import { expect, it } from 'vitest';

import { isPolicySatisfied, validateBackend } from './backend-validation.js';
import type { SandboxBackend, SandboxPolicy } from './contracts.js';
import type { ProviderInfo } from './protocol.js';

const provider: ProviderInfo = {
	id: 'fixture',
	label: 'Fixture provider',
	capabilities: {
		processKinds: ['argv', 'shell'],
		terminationScope: 'workload',
		exitStatus: 'guaranteed',
		operations: [
			'exec',
			'files.read',
			'files.write',
			'files.list',
			'search.find',
			'search.grep'
		],
		shells: ['sh', 'bash']
	},
	policies: {
		workspaceAccess: ['read-only', 'read-write'],
		filesystemScope: ['workspace-only', 'provider-default'],
		networkAccess: ['denied', 'provider-default']
	}
};
const policy: SandboxPolicy = {
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
};

const stat = () => Promise.resolve({ kind: 'file' as const, size: 0 });
const access = () => Promise.resolve();

function backend(): SandboxBackend {
	return {
		id: 'backend',
		workspace: {
			root: '/target',
			pathFlavor: 'posix',
			relationship: 'remote',
			description: 'Protocol fixture.'
		},
		capabilities: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: []
		},
		policy,
		policyDescription: 'Protocol fixture only.',
		recovery: { kind: 'none' },
		exec: () =>
			Promise.resolve({ kind: 'exited', exit: { kind: 'code', code: 0 } }),
		dispose: () => Promise.resolve()
	};
}

it('accepts an execution-only backend with fewer capabilities than its provider', () => {
	const value = backend();

	expect(validateBackend(value, provider, policy)).toBe(value);
});

it.each([
	{ exec: undefined },
	{ dispose: undefined },
	{ id: '' },
	{ recovery: undefined },
	{
		recovery: {
			kind: 'allocation',
			id: 'resource',
			instructions: 'Release it.'
		}
	},
	{
		capabilities: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec', 'exec'],
			shells: []
		}
	},
	{
		capabilities: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec', 'pty'],
			shells: []
		}
	},
	{
		capabilities: {
			processKinds: ['argv', 'shell'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: ['powershell']
		}
	},
	{ files: { read: { readFile: () => Promise.resolve(new Uint8Array()) } } },
	{
		files: {
			read: { readFile: () => Promise.resolve(new Uint8Array()), access, stat }
		}
	},
	{ search: { find: () => Promise.resolve({ paths: [], truncated: false }) } },
	{ workspace: { ...backend().workspace, root: 'relative' } },
	{ workspace: { ...backend().workspace, home: 'relative' } },
	{ workspace: { ...backend().workspace, defaultShell: 'sh' } },
	{ workspace: { ...backend().workspace, root: '/target\0bad' } }
])(
	'rejects inconsistent backend metadata before a handle can be returned: %j',
	(override) => {
		expect(() =>
			validateBackend({ ...backend(), ...override }, provider, policy)
		).toThrow(
			expect.objectContaining({
				name: 'InvalidSandboxDeclarationError',
				operation: 'open',
				providerId: 'fixture'
			})
		);
	}
);

it.each([
	'files.read',
	'files.write',
	'files.list',
	'search.find',
	'search.grep'
])(
	'rejects an advertised capability without its operations: %s',
	(capability) => {
		expect(() =>
			validateBackend(
				{
					...backend(),
					capabilities: {
						processKinds: ['argv'],
						terminationScope: 'workload',
						exitStatus: 'guaranteed',
						operations: ['exec', capability],
						shells: []
					}
				},
				provider,
				policy
			)
		).toThrow(
			expect.objectContaining({
				name: 'InvalidSandboxDeclarationError',
				operation: 'open',
				providerId: 'fixture'
			})
		);
	}
);

it('validates target-native Windows paths without probing the host', () => {
	const value = {
		...backend(),
		workspace: {
			root: 'C:\\target',
			home: 'C:\\Users\\fixture',
			pathFlavor: 'win32' as const,
			relationship: 'copied' as const,
			description: 'Target-native Windows fixture.'
		}
	};

	expect(validateBackend(value, provider, policy)).toBe(value);
});

it('accepts advertised filesystem and search groups with every required method', () => {
	const value: SandboxBackend = {
		...backend(),
		capabilities: provider.capabilities,
		files: {
			read: { readFile: () => Promise.resolve(new Uint8Array()), access, stat },
			write: {
				writeFile: () => Promise.resolve(),
				access,
				mkdir: () => Promise.resolve()
			},
			list: { listDirectory: () => Promise.resolve([]), stat }
		},
		search: {
			find: () => Promise.resolve({ paths: [], truncated: false }),
			grep: () => Promise.resolve({ matches: [], truncated: false })
		}
	};

	expect(validateBackend(value, provider, policy)).toBe(value);
});

it.each([
	{ workspaceAccess: 'read-only' },
	{ filesystemScope: 'workspace-only' },
	{ networkAccess: 'denied' }
] as const)(
	'rejects effective policy that weakens a requirement: %j',
	(required) => {
		expect(() =>
			validateBackend(backend(), provider, { ...policy, ...required })
		).toThrow(
			expect.objectContaining({
				name: 'UnsupportedSandboxPolicyError',
				operation: 'open',
				providerId: 'fixture',
				backendId: 'backend'
			})
		);
	}
);

it('accepts restrictive effective policy for a delegated dimension', () => {
	const value = {
		...backend(),
		policy: {
			...policy,
			filesystemScope: 'workspace-only' as const,
			networkAccess: 'denied' as const
		}
	};

	expect(validateBackend(value, provider, policy)).toBe(value);
	expect(isPolicySatisfied(value.policy, { networkAccess: 'denied' })).toBe(
		true
	);
	expect(isPolicySatisfied(policy, { networkAccess: 'denied' })).toBe(false);
});

it('rejects effective policy that the provider did not advertise', () => {
	const declaration = {
		...provider,
		policies: {
			...provider.policies,
			networkAccess: ['provider-default' as const]
		}
	};
	const value = {
		...backend(),
		policy: { ...policy, networkAccess: 'denied' as const }
	};

	expect(() => validateBackend(value, declaration, policy)).toThrow(
		expect.objectContaining({
			name: 'InvalidSandboxDeclarationError',
			operation: 'open',
			providerId: 'fixture'
		})
	);
});

it.each([
	{ declared: 'none', effective: 'process-group', satisfies: true },
	{ declared: 'process-group', effective: 'workload', satisfies: true },
	{ declared: 'workload', effective: 'process-group', satisfies: false },
	{ declared: 'process-group', effective: 'none', satisfies: false }
] as const)(
	'validates $effective termination against declared $declared',
	({ declared, effective, satisfies }) => {
		const value = backend();
		const selected = {
			...provider,
			capabilities: { ...provider.capabilities, terminationScope: declared }
		};
		const opened = {
			...value,
			capabilities: { ...value.capabilities, terminationScope: effective }
		};
		const validate = () => validateBackend(opened, selected, policy);

		if (satisfies) {
			expect(validate()).toStrictEqual(opened);

			return;
		}

		expect(validate).toThrow(
			expect.objectContaining({ name: 'InvalidSandboxDeclarationError' })
		);
	}
);

it.each([
	['workspace-only', 'workspace-only', true],
	['workspace-only', 'system-read-only', true],
	['workspace-only', 'provider-default', true],
	['system-read-only', 'workspace-only', false],
	['system-read-only', 'system-read-only', true],
	['system-read-only', 'provider-default', true],
	['provider-default', 'workspace-only', false],
	['provider-default', 'system-read-only', false],
	['provider-default', 'provider-default', true]
] as const)(
	'checks filesystem scope %s against %s',
	(effective, required, expected) => {
		expect(
			isPolicySatisfied(
				{ ...policy, filesystemScope: effective },
				{ filesystemScope: required }
			)
		).toBe(expected);
	}
);
