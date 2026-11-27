import { Type } from 'typebox';

import { grantedPathsSchema, workspaceSchema } from './backend-schemas.js';
import type {
	Sandbox,
	SandboxCopy,
	SandboxFiles,
	SandboxSearch
} from './contracts.js';
import { closeReportSchema, errorSchema } from './error-schema.js';
import { profileSchema } from './policy-model.js';
import {
	directoryEntriesSchema,
	findResultSchema,
	grepResultSchema,
	processExitSchema
} from './result-schemas.js';
import {
	bytesSchema,
	callable,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	targetPathSchema
} from './schemas.js';

const operationOptions = Type.Optional(Type.Ref('sandbox.operationOptions'));
const readOptions = Type.Optional(Type.Ref('sandbox.readOptions'));
const processOptions = Type.Optional(Type.Ref('sandbox.processOptions'));
const copyOptions = Type.Optional(Type.Ref('broker.acquireOptions'));
const noResult = Type.Undefined();

export const negotiationSchema = Type.Union([
	Type.Object(
		{ ok: Type.Literal(true), profile: profileSchema },
		{ additionalProperties: false }
	),
	Type.Object(
		{ ok: Type.Literal(false), error: errorSchema },
		{ additionalProperties: false }
	)
]);

export const processResultSchema = Type.Object(
	{
		exit: processExitSchema,
		stdout: bytesSchema,
		stderr: bytesSchema,
		omittedBytes: Type.Object(
			{ stdout: nonNegativeIntegerSchema, stderr: nonNegativeIntegerSchema },
			{
				additionalProperties: false
			}
		)
	},
	{ additionalProperties: false }
);

export const directoryResultSchema = Type.Union([
	directoryEntriesSchema('posix'),
	directoryEntriesSchema('win32')
]);

export const findResults = Type.Union([
	findResultSchema('posix', Number.MAX_SAFE_INTEGER),
	findResultSchema('win32', Number.MAX_SAFE_INTEGER)
]);

export const grepResults = Type.Union([
	grepResultSchema('posix', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER),
	grepResultSchema('win32', Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER)
]);

const files = Type.Object({
	readFile: callable<SandboxFiles['readFile']>(
		[targetPathSchema, readOptions],
		bytesSchema,
		'async'
	),
	writeFile: callable<SandboxFiles['writeFile']>(
		[targetPathSchema, bytesSchema, operationOptions],
		noResult,
		'async'
	),
	access: callable<SandboxFiles['access']>(
		[targetPathSchema, Type.Ref('sandbox.accessMode'), operationOptions],
		noResult,
		'async'
	),
	stat: callable<SandboxFiles['stat']>(
		[targetPathSchema, operationOptions],
		Type.Ref('sandbox.fileStat'),
		'async'
	),
	mkdir: callable<SandboxFiles['mkdir']>(
		[targetPathSchema, operationOptions],
		noResult,
		'async'
	),
	listDirectory: callable<SandboxFiles['listDirectory']>(
		[targetPathSchema, operationOptions],
		Type.Ref('sandbox.directoryEntries'),
		'async'
	)
});
const search = Type.Object({
	find: callable<SandboxSearch['find']>(
		[Type.Ref('sandbox.findRequest'), operationOptions],
		Type.Ref('sandbox.findResult'),
		'async'
	),
	grep: callable<SandboxSearch['grep']>(
		[Type.Ref('sandbox.grepRequest'), operationOptions],
		Type.Ref('sandbox.grepResult'),
		'async'
	)
});

const sandboxHandleShape = Type.Object({
	providerId: nonEmptyStringSchema,
	backendId: nonEmptyStringSchema,
	generationId: nonEmptyStringSchema,
	profile: profileSchema,
	workspace: workspaceSchema,
	grantedPaths: Type.Optional(grantedPathsSchema),
	exec: callable<Sandbox['exec']>(
		[Type.Ref('sandbox.processRequest'), processOptions],
		Type.Ref('sandbox.processResult'),
		'async'
	),
	files,
	search,
	copy: callable<Sandbox['copy']>(
		[copyOptions],
		Type.Ref('sandbox.ownedCopy'),
		'async'
	)
});

export const sandboxHandleSchema = Type.Unsafe<Sandbox>(sandboxHandleShape);

const closeCopy = callable<SandboxCopy['close']>(
	[],
	closeReportSchema,
	'async'
);

export const ownedCopySchema = Type.Unsafe<SandboxCopy>(
	Type.Object({ sandbox: sandboxHandleSchema, close: closeCopy })
);
