import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import {
	acquireOptionsSchema,
	processRequestSchema,
	providerConfigSchema,
	sandboxRequirementsSchema
} from './request-schemas.js';
import {
	capabilitiesSchema,
	recoverySchema,
	safeIntegerSchema
} from './schemas.js';

const sparse: string[] = ['exec'];

sparse.length++;

it.each([
	{ schema: sandboxRequirementsSchema, input: {}, expected: true },
	{
		schema: sandboxRequirementsSchema,
		input: { providerId: 'expected', terminationScope: 'workload' },
		expected: true
	},
	{
		schema: sandboxRequirementsSchema,
		input: { providerId: '' },
		expected: false
	},
	{
		schema: sandboxRequirementsSchema,
		input: { timeoutMs: 100 },
		expected: false
	},
	{
		schema: sandboxRequirementsSchema,
		input: { signal: new AbortController().signal },
		expected: false
	},

	{
		schema: capabilitiesSchema,
		input: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: []
		},
		expected: true
	},
	{
		schema: capabilitiesSchema,
		input: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: sparse,
			shells: []
		},
		expected: false
	},
	{
		schema: capabilitiesSchema,
		input: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['files.read'],
			shells: []
		},
		expected: false
	},
	{
		schema: capabilitiesSchema,
		input: {
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec', 'exec'],
			shells: []
		},
		expected: false
	},
	{ schema: safeIntegerSchema, input: Number.MAX_SAFE_INTEGER, expected: true },
	{ schema: safeIntegerSchema, input: 2 ** 53, expected: false },
	{ schema: safeIntegerSchema, input: Infinity, expected: false },
	{
		schema: processRequestSchema,
		input: { kind: 'argv', executable: 'program', args: sparse },
		expected: false
	},
	{
		schema: processRequestSchema,
		input: {
			kind: 'shell',
			command: '',
			dialect: 'sh',
			env: JSON.parse('{"DELETE":null}') as unknown
		},
		expected: true
	},
	{
		schema: processRequestSchema,
		input: { kind: 'shell', command: '', dialect: 'sh', executable: undefined },
		expected: false
	},
	{
		schema: processRequestSchema,
		input: { kind: 'shell', command: '', dialect: 'sh', env: { 'A=B': 'bad' } },
		expected: false
	},
	{
		schema: acquireOptionsSchema,
		input: { policy: { unrecognised: undefined } },
		expected: false
	},
	{
		schema: providerConfigSchema,
		input: { configuration: {}, userShell: undefined },
		expected: true
	},
	{ schema: providerConfigSchema, input: { extra: true }, expected: false },
	{
		schema: providerConfigSchema,
		input: {
			policy: {
				workspaceAccess: 'read-write',
				filesystemScope: 'provider-default',
				networkAccess: 'denied',
				extra: true
			}
		},
		expected: false
	},
	{
		schema: recoverySchema,
		input: {
			kind: 'allocation',
			id: 'resource',
			instructions: 'Remove the resource.',
			lease: 'manual',
			expiresAt: '1 November 2026'
		},
		expected: true
	},
	{
		schema: recoverySchema,
		input: {
			kind: 'allocation',
			id: 'resource',
			instructions: 'Remove the resource.',
			lease: 'manual',
			expiresAt: 'invalid'
		},
		expected: false
	}
])(
	'preserves boundary validation for $input',
	({ schema, input, expected }) => {
		const validator = Compile(schema);

		expect({
			interpreted: Value.Check(schema, input),
			compiled: validator.Check(input)
		}).toStrictEqual({ interpreted: expected, compiled: expected });
	}
);
