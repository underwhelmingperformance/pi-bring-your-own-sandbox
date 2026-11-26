import type { Static, TArrayOptions, TSchema } from 'typebox';
import { Type } from 'typebox';
import { Compile } from 'typebox/compile';

import { wholeOffer } from './protocol-schema.js';
import { canProtectWorkspace } from './workspace-protection.js';

export function checker<Schema extends TSchema>(schema: Schema) {
	const validator = Compile(schema);

	return (value: unknown): value is Static<Schema> => validator.Check(value);
}

export function denseArray<Item extends TSchema>(
	item: Item,
	options?: TArrayOptions
) {
	return Type.Refine(Type.Array(item, options), (items) =>
		items.values().every((_, index) => Object.hasOwn(items, index))
	);
}

export function callable<
	Signature extends (...arguments_: never[]) => unknown
>() {
	return Type.Unsafe<Signature>(Type.Function([], Type.Unknown()));
}

export const recordSchema = Type.Record(Type.String(), Type.Unknown());
export const nonEmptyStringSchema = Type.String({ minLength: 1 });
export const safeTextSchema = Type.String({ pattern: '^[^\\u0000]*$' });
export const targetPathSchema = Type.String({
	minLength: 1,
	pattern: '^[^\\u0000]*$'
});
export const safeIntegerSchema = Type.Integer({
	minimum: Number.MIN_SAFE_INTEGER,
	maximum: Number.MAX_SAFE_INTEGER
});
export const nonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER
});
export const positiveIntegerSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER
});
export const timeoutSchema = Type.Number({
	exclusiveMinimum: 0,
	maximum: Number.MAX_VALUE
});
export const shellSchema = Type.Union([
	Type.Literal('bash'),
	Type.Literal('sh'),
	Type.Literal('powershell')
]);
export const capabilitySchema = Type.Union([
	Type.Literal('exec'),
	Type.Literal('files.read'),
	Type.Literal('files.write'),
	Type.Literal('files.list'),
	Type.Literal('search.find'),
	Type.Literal('search.grep'),
	Type.Literal('workspace.protection'),
	Type.Literal('copy')
]);
export const processKindSchema = Type.Union([
	Type.Literal('argv'),
	Type.Literal('shell')
]);

const exitStatusSchema = Type.Union([
	Type.Literal('guaranteed'),
	Type.Literal('optional')
]);

export const terminationScopeSchema = Type.Union([
	Type.Literal('none'),
	Type.Literal('process-group'),
	Type.Literal('workload')
]);

const capabilitiesShape = Type.Object({
	operations: denseArray(capabilitySchema, {
		uniqueItems: true,
		contains: Type.Literal('exec')
	}),
	shells: denseArray(shellSchema, { uniqueItems: true }),
	processKinds: denseArray(processKindSchema, {
		minItems: 1,
		uniqueItems: true
	}),
	exitStatus: exitStatusSchema,
	terminationScope: terminationScopeSchema
});

export const capabilitiesSchema = Type.Refine(
	capabilitiesShape,
	(value) => value.processKinds.includes('shell') === value.shells.length > 0
);

export const workspaceRelationshipSchema = Type.Union([
	Type.Literal('shared'),
	Type.Literal('copied'),
	Type.Literal('remote')
]);

const workspaceAccessSchema = Type.Union([
	Type.Literal('read-only'),
	Type.Literal('read-write')
]);
const filesystemScopeSchema = Type.Union([
	Type.Literal('workspace-only'),
	Type.Literal('system-read-only'),
	Type.Literal('provider-default')
]);
const networkAccessSchema = Type.Union([
	Type.Literal('denied'),
	Type.Literal('provider-default')
]);

export const guaranteeSchema = Type.Union([
	Type.Literal('no-workspace-writes'),
	Type.Literal('no-network'),
	Type.Literal('no-host-user-data'),
	Type.Literal('no-host-system-files')
]);
export const accessSchema = Type.Union([
	Type.Literal('workspace-writes'),
	Type.Literal('network'),
	Type.Literal('host-user-data'),
	Type.Literal('host-system-files')
]);

const protectedPathSchema = Type.Refine(
	targetPathSchema,
	(value) =>
		!value.includes('\\') &&
		!value.includes(':') &&
		value.split('/').every((part) => !['', '.', '..'].includes(part))
);

const gitProtectionSchema = Type.Object(
	{ kind: Type.Literal('git-metadata') },
	{ additionalProperties: false }
);
const pathProtectionSchema = Type.Object(
	{ kind: Type.Literal('path'), path: protectedPathSchema },
	{ additionalProperties: false }
);

export const workspaceProtectionSchema = denseArray(
	Type.Union([gitProtectionSchema, pathProtectionSchema]),
	{ uniqueItems: true, maxItems: 128 }
);

export const policySchema = wholeOffer(
	Type.Object({
		workspaceRelationship: Type.Optional(workspaceRelationshipSchema),
		workspaceProtection: Type.Optional(workspaceProtectionSchema),
		workspaceAccess: workspaceAccessSchema,
		filesystemScope: filesystemScopeSchema,
		networkAccess: networkAccessSchema
	})
);

const supportedPoliciesSchema = Type.Object({
	workspaceRelationship: Type.Optional(
		denseArray(workspaceRelationshipSchema, { minItems: 1, uniqueItems: true })
	),
	workspaceAccess: denseArray(workspaceAccessSchema, {
		minItems: 1,
		uniqueItems: true
	}),
	filesystemScope: denseArray(filesystemScopeSchema, {
		minItems: 1,
		uniqueItems: true
	}),
	networkAccess: denseArray(networkAccessSchema, {
		minItems: 1,
		uniqueItems: true
	})
});

export const providerInfoSchema = Type.Refine(
	Type.Object({
		id: nonEmptyStringSchema,
		label: nonEmptyStringSchema,
		capabilities: capabilitiesSchema,
		policies: supportedPoliciesSchema,
		defaultPolicy: Type.Optional(policySchema)
	}),
	(provider) =>
		provider.defaultPolicy === undefined ||
		((provider.defaultPolicy.workspaceRelationship === undefined ||
			provider.policies.workspaceRelationship?.includes(
				provider.defaultPolicy.workspaceRelationship
			) === true) &&
			provider.policies.workspaceAccess.includes(
				provider.defaultPolicy.workspaceAccess
			) &&
			provider.policies.filesystemScope.includes(
				provider.defaultPolicy.filesystemScope
			) &&
			provider.policies.networkAccess.includes(
				provider.defaultPolicy.networkAccess
			) &&
			canProtectWorkspace(provider.capabilities, provider.defaultPolicy))
);

const expirySchema = Type.Refine(Type.String(), (value) =>
	Number.isFinite(Date.parse(value))
);

export const recoverySchema = Type.Union([
	Type.Object({ kind: Type.Literal('none') }),
	Type.Object({
		kind: Type.Literal('allocation'),
		id: nonEmptyStringSchema,
		instructions: nonEmptyStringSchema,
		lease: nonEmptyStringSchema,
		expiresAt: Type.Optional(expirySchema)
	})
]);

export const bytesSchema = Type.Unsafe<Uint8Array>(
	Type.Refine(Type.Unknown(), (value) => value instanceof Uint8Array)
);
export const signalSchema = Type.Unsafe<AbortSignal>(
	Type.Object({
		aborted: Type.Boolean(),
		addEventListener: callable<AbortSignal['addEventListener']>(),
		removeEventListener: callable<AbortSignal['removeEventListener']>(),
		dispatchEvent: callable<AbortSignal['dispatchEvent']>(),
		throwIfAborted: callable<AbortSignal['throwIfAborted']>(),
		reason: Type.Unknown()
	})
);
