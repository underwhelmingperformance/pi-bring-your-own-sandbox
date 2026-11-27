import { Compile } from 'typebox/compile';
import { Value } from 'typebox/value';
import { expect, it } from 'vitest';

import { defaultPolicy, profileSchema } from './policy-model.js';
import {
	acquireOptionsSchema,
	processRequestSchema,
	providerConfigSchema
} from './request-schemas.js';
import { recoverySchema, safeIntegerSchema } from './schemas.js';

const sparse: string[] = ['files.read'];

sparse.length++;

it.each([
	{ schema: acquireOptionsSchema, input: {}, expected: true },
	{
		schema: acquireOptionsSchema,
		input: { terminationScope: 'workload' },
		expected: true
	},
	{
		schema: acquireOptionsSchema,
		input: { providerId: '' },
		expected: false
	},
	{
		schema: acquireOptionsSchema,
		input: { timeoutMs: 100 },
		expected: true
	},
	{
		schema: acquireOptionsSchema,
		input: { signal: new AbortController().signal },
		expected: true
	},

	{
		schema: profileSchema,
		input: {
			policy: defaultPolicy,
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			capabilities: [],
			shells: []
		},
		expected: true
	},
	{
		schema: profileSchema,
		input: {
			policy: defaultPolicy,
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			capabilities: sparse,
			shells: []
		},
		expected: false
	},
	{
		schema: profileSchema,
		input: {
			policy: defaultPolicy,
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			capabilities: ['files.read'],
			shells: []
		},
		expected: true
	},
	{
		schema: profileSchema,
		input: {
			policy: defaultPolicy,
			processKinds: ['argv'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			capabilities: ['files.read', 'files.read'],
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
		input: { configuration: {}, settings: { userShell: undefined } },
		expected: true
	},
	{ schema: providerConfigSchema, input: { extra: true }, expected: false },
	{
		schema: providerConfigSchema,
		input: {
			policy: {
				hostWorkspaceWrites: true,
				hostUserData: 'denied',
				hostSystemFiles: 'read-only',
				network: false,
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
