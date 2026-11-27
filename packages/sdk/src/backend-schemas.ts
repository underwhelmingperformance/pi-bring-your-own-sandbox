import path from 'node:path';

import { Type } from 'typebox';

import type {
	BackendDirectoryReader,
	BackendFileReader,
	BackendFileWriter,
	BackendSearch,
	SandboxBackend
} from './contracts.js';
import { profileSchema } from './policy-model.js';
import {
	bytesSchema,
	callable,
	denseArray,
	hostUserDataRootsSchema,
	nonEmptyStringSchema,
	nonNegativeIntegerSchema,
	recoverySchema,
	shellSchema,
	targetPathSchema,
	workspaceRelationshipSchema
} from './schemas.js';
import { checker } from './schemas.js';

function absolutePathSchema(flavor: 'posix' | 'win32') {
	return Type.Refine(targetPathSchema, (value) =>
		path[flavor].isAbsolute(value)
	);
}

const absolutePaths = {
	posix: absolutePathSchema('posix'),
	win32: absolutePathSchema('win32')
};
const absolutePathChecks = {
	posix: checker(absolutePaths.posix),
	win32: checker(absolutePaths.win32)
};

export function isAbsoluteWorkspacePath(
	value: unknown,
	flavor: 'posix' | 'win32'
): boolean {
	return absolutePathChecks[flavor](value);
}

function workspaceShape(flavor: 'posix' | 'win32') {
	return Type.Object({
		pathFlavor: Type.Literal(flavor),
		root: absolutePaths[flavor],
		home: Type.Optional(absolutePaths[flavor]),
		hostUserDataRoot: Type.Optional(absolutePaths[flavor]),
		relationship: workspaceRelationshipSchema,
		defaultShell: Type.Optional(shellSchema)
	});
}

export const workspaceSchema = Type.Union([
	workspaceShape('posix'),
	workspaceShape('win32')
]);

const operationContext = Type.Ref('provider.operationContext');
const noResult = Type.Undefined();

const fileReaderSchema = Type.Object({
	readFile: callable<BackendFileReader['readFile']>(
		[
			targetPathSchema,
			operationContext,
			Type.Optional(nonNegativeIntegerSchema)
		],
		bytesSchema,
		'async'
	),
	access: callable<BackendFileReader['access']>(
		[targetPathSchema, operationContext],
		noResult,
		'async'
	),
	stat: callable<BackendFileReader['stat']>(
		[targetPathSchema, operationContext],
		Type.Ref('sandbox.fileStat'),
		'async'
	)
});
const fileWriterSchema = Type.Object({
	writeFile: callable<BackendFileWriter['writeFile']>(
		[targetPathSchema, bytesSchema, operationContext],
		noResult,
		'async'
	),
	access: callable<BackendFileWriter['access']>(
		[targetPathSchema, operationContext],
		noResult,
		'async'
	),
	mkdir: callable<BackendFileWriter['mkdir']>(
		[targetPathSchema, operationContext],
		noResult,
		'async'
	)
});
const directoryReaderSchema = Type.Object({
	listDirectory: callable<BackendDirectoryReader['listDirectory']>(
		[targetPathSchema, operationContext],
		Type.Ref('sandbox.directoryEntries'),
		'async'
	),
	stat: callable<BackendDirectoryReader['stat']>(
		[targetPathSchema, operationContext],
		Type.Ref('sandbox.fileStat'),
		'async'
	)
});
const filesSchema = Type.Object({
	read: Type.Optional(fileReaderSchema),
	write: Type.Optional(fileWriterSchema),
	list: Type.Optional(directoryReaderSchema)
});
const find = callable<NonNullable<BackendSearch['find']>>(
	[Type.Ref('sandbox.findRequest'), operationContext],
	Type.Ref('sandbox.findResult'),
	'async'
);
const grep = callable<NonNullable<BackendSearch['grep']>>(
	[Type.Ref('sandbox.grepRequest'), operationContext],
	Type.Ref('sandbox.grepResult'),
	'async'
);
const searchSchema = Type.Object({
	find: Type.Optional(find),
	grep: Type.Optional(grep)
});

const pathGrantKind = Type.Union([Type.Literal('read'), Type.Literal('write')]);
const grantedPathSchema = Type.Object(
	{
		kind: pathGrantKind,
		hostPath: targetPathSchema,
		targetPath: targetPathSchema
	},
	{ additionalProperties: false }
);

export const grantedPathsSchema = denseArray(grantedPathSchema);

const backendShape = Type.Object({
	id: nonEmptyStringSchema,
	profile: profileSchema,
	workspace: workspaceSchema,
	grantedPaths: Type.Optional(grantedPathsSchema),
	hostUserDataRoots: Type.Optional(hostUserDataRootsSchema),
	policyDescription: nonEmptyStringSchema,
	recovery: recoverySchema,
	exec: callable<SandboxBackend['exec']>(
		[Type.Ref('sandbox.processRequest'), Type.Ref('provider.processContext')],
		Type.Ref('sandbox.processOutcome'),
		'async'
	),
	dispose: callable<SandboxBackend['dispose']>(
		[operationContext],
		noResult,
		'async'
	),
	files: Type.Optional(filesSchema),
	search: Type.Optional(searchSchema)
});

export const backendSchema = Type.Refine(backendShape, (value) => {
	const { capabilities: operations, shells } = value.profile;

	return (
		(value.workspace.defaultShell === undefined ||
			shells.includes(value.workspace.defaultShell)) &&
		operations.includes('files.read') === (value.files?.read !== undefined) &&
		operations.includes('files.write') === (value.files?.write !== undefined) &&
		operations.includes('files.list') === (value.files?.list !== undefined) &&
		operations.includes('search.find') === (value.search?.find !== undefined) &&
		operations.includes('search.grep') === (value.search?.grep !== undefined)
	);
});
