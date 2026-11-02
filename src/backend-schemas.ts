import path from 'node:path';

import { Type } from 'typebox';

import type {
	BackendDirectoryReader,
	BackendFileReader,
	BackendFileWriter,
	BackendSearch,
	SandboxBackend,
	SandboxPolicy
} from './contracts.js';
import type { ProviderInfo } from './protocol.js';
import {
	callable,
	capabilitiesSchema,
	denseArray,
	nonEmptyStringSchema,
	policySchema,
	recoverySchema,
	shellSchema,
	targetPathSchema
} from './schemas.js';

export function absolutePathSchema(flavor: 'posix' | 'win32') {
	return Type.Refine(targetPathSchema, (value) =>
		path[flavor].isAbsolute(value)
	);
}

function workspaceShape(flavor: 'posix' | 'win32') {
	return Type.Object({
		pathFlavor: Type.Literal(flavor),
		root: absolutePathSchema(flavor),
		home: Type.Optional(absolutePathSchema(flavor)),
		description: nonEmptyStringSchema,
		relationship: Type.Enum(['shared', 'copied', 'remote']),
		defaultShell: Type.Optional(shellSchema)
	});
}

export const workspaceSchema = Type.Union([
	workspaceShape('posix'),
	workspaceShape('win32')
]);

const fileReaderSchema = Type.Object({
	readFile: callable<BackendFileReader['readFile']>(),
	access: callable<BackendFileReader['access']>(),
	stat: callable<BackendFileReader['stat']>()
});
const fileWriterSchema = Type.Object({
	writeFile: callable<BackendFileWriter['writeFile']>(),
	access: callable<BackendFileWriter['access']>(),
	mkdir: callable<BackendFileWriter['mkdir']>()
});
const directoryReaderSchema = Type.Object({
	listDirectory: callable<BackendDirectoryReader['listDirectory']>(),
	stat: callable<BackendDirectoryReader['stat']>()
});
const filesSchema = Type.Object({
	read: Type.Optional(fileReaderSchema),
	write: Type.Optional(fileWriterSchema),
	list: Type.Optional(directoryReaderSchema)
});
const searchSchema = Type.Object({
	find: Type.Optional(callable<NonNullable<BackendSearch['find']>>()),
	grep: Type.Optional(callable<NonNullable<BackendSearch['grep']>>())
});

const backendShape = Type.Object({
	id: nonEmptyStringSchema,
	capabilities: capabilitiesSchema,
	workspace: workspaceSchema,
	policy: policySchema,
	policyDescription: nonEmptyStringSchema,
	recovery: recoverySchema,
	exec: callable<SandboxBackend['exec']>(),
	dispose: callable<SandboxBackend['dispose']>(),
	files: Type.Optional(filesSchema),
	search: Type.Optional(searchSchema)
});

export const backendSchema = Type.Refine(backendShape, (value) => {
	const { operations, shells } = value.capabilities;

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

export function providerBackendSchema(provider: ProviderInfo) {
	const operations = Type.Enum([...provider.capabilities.operations]);
	const shells = Type.Enum([...provider.capabilities.shells]);
	const policy = Type.Object({
		workspaceAccess: Type.Enum([...provider.policies.workspaceAccess]),
		filesystemScope: Type.Enum([...provider.policies.filesystemScope]),
		networkAccess: Type.Enum([...provider.policies.networkAccess])
	});
	const capabilities = Type.Object({
		operations: denseArray(operations),
		shells: denseArray(shells),
		processKinds: denseArray(
			Type.Enum([...provider.capabilities.processKinds])
		),
		exitStatus:
			provider.capabilities.exitStatus === 'guaranteed'
				? Type.Literal('guaranteed')
				: Type.Enum(['guaranteed', 'optional'])
	});

	return Type.Intersect([backendSchema, Type.Object({ capabilities, policy })]);
}

export function requiredPolicySchema(required: Partial<SandboxPolicy>) {
	return Type.Object({
		workspaceAccess:
			required.workspaceAccess === undefined
				? policySchema.properties.workspaceAccess
				: Type.Literal(required.workspaceAccess),
		filesystemScope:
			required.filesystemScope === 'workspace-only'
				? Type.Literal('workspace-only')
				: policySchema.properties.filesystemScope,
		networkAccess:
			required.networkAccess === 'denied'
				? Type.Literal('denied')
				: policySchema.properties.networkAccess
	});
}
