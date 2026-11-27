import type { Static } from 'typebox';
import { Type } from 'typebox';

import { wholeOffer } from './protocol-schema.js';
import {
	capabilitySchema,
	denseArray,
	nonEmptyStringSchema,
	processKindSchema,
	shellSchema,
	targetPathSchema,
	terminationScopeSchema
} from './schemas.js';

type Frozen<Value> = Value extends object
	? { readonly [Key in keyof Value]: Frozen<Value[Key]> }
	: Value;

const fileAccessSchema = Type.Union([
	Type.Literal('denied'),
	Type.Literal('read-only'),
	Type.Literal('read-write')
]);

export const accessPolicySchema = wholeOffer(
	Type.Object(
		{
			hostWorkspaceWrites: Type.Boolean(),
			network: Type.Boolean(),
			hostUserData: fileAccessSchema,
			hostSystemFiles: fileAccessSchema
		},
		{ additionalProperties: false }
	)
);
export type Policy = Frozen<Static<typeof accessPolicySchema>>;
export type AccessProperty = keyof Policy;

export const accessStateSchema = Type.Union([
	Type.Literal('needed'),
	Type.Literal('prevented')
]);

const optionalState = Type.Optional(accessStateSchema);
const accessFields = {
	hostWorkspaceWrites: optionalState,
	network: optionalState,
	hostUserData: optionalState,
	hostSystemFiles: optionalState
} satisfies Record<AccessProperty, typeof optionalState>;

export const pathGrantsSchema = Type.Object(
	{
		read: Type.Optional(denseArray(targetPathSchema, { uniqueItems: true })),
		write: Type.Optional(denseArray(targetPathSchema, { uniqueItems: true }))
	},
	{ additionalProperties: false }
);
export const accessSchema = Type.Object(
	{ ...accessFields, paths: Type.Optional(pathGrantsSchema) },
	{ additionalProperties: false }
);
export type Access = Frozen<Static<typeof accessSchema>>;
export type AccessState = Static<typeof accessStateSchema>;
export type PathGrants = Frozen<Static<typeof pathGrantsSchema>>;

const exitStatus = Type.Union([
	Type.Literal('guaranteed'),
	Type.Literal('optional')
]);
const grantKind = Type.Union([Type.Literal('read'), Type.Literal('write')]);
const pathGrantKinds = denseArray(grantKind, { uniqueItems: true });
const profileShape = Type.Object(
	{
		policy: accessPolicySchema,
		capabilities: denseArray(capabilitySchema, {
			uniqueItems: true
		}),
		processKinds: denseArray(processKindSchema, {
			uniqueItems: true,
			minItems: 1
		}),
		shells: denseArray(shellSchema, { uniqueItems: true }),
		exitStatus,
		terminationScope: terminationScopeSchema,
		pathGrantKinds: Type.Optional(pathGrantKinds),
		credentialPathGrantKinds: Type.Optional(pathGrantKinds)
	},
	{ additionalProperties: false }
);

export const profileSchema = Type.Refine(
	profileShape,
	(profile) =>
		profile.processKinds.includes('shell') === profile.shells.length > 0 &&
		(profile.credentialPathGrantKinds ?? []).every(
			(kind) => profile.pathGrantKinds?.includes(kind) === true
		)
);
/**
Effective restrictions for an allocation. Read-only and read-write host user
data exclude credential locations outside the checkout. A provider can grant
an excluded path for an approved escalation of a kind listed in
`credentialPathGrantKinds`.
*/
export type Profile = Frozen<Static<typeof profileSchema>>;

export const defaultPolicy: Policy = Object.freeze({
	hostWorkspaceWrites: true,
	network: false,
	hostUserData: 'read-only',
	hostSystemFiles: 'read-only'
});

export const unrestrictedPolicy: Policy = Object.freeze({
	hostWorkspaceWrites: true,
	network: true,
	hostUserData: 'read-write',
	hostSystemFiles: 'read-write'
});

const fileRank: Record<Policy['hostUserData'], number> = {
	denied: 0,
	'read-only': 1,
	'read-write': 2
};

export const accessRanks = {
	hostWorkspaceWrites: (policy: Policy) => Number(policy.hostWorkspaceWrites),
	network: (policy: Policy) => Number(policy.network),
	hostUserData: (policy: Policy) => fileRank[policy.hostUserData],
	hostSystemFiles: (policy: Policy) => fileRank[policy.hostSystemFiles]
} satisfies Record<AccessProperty, (policy: Policy) => number>;

export const accessOrder = Object.freeze(
	Object.keys(accessRanks) as AccessProperty[]
);

function compareCodeUnits(left: string, right: string): number {
	return Number(left > right) - Number(left < right);
}

export function profileKey(profile: Profile): string {
	return JSON.stringify([
		accessOrder.map((property) => profile.policy[property]),
		profile.capabilities.toSorted(compareCodeUnits),
		profile.processKinds.toSorted(compareCodeUnits),
		profile.shells.toSorted(compareCodeUnits),
		profile.exitStatus,
		profile.terminationScope,
		(profile.pathGrantKinds ?? []).toSorted(compareCodeUnits),
		(profile.credentialPathGrantKinds ?? []).toSorted(compareCodeUnits)
	]);
}

const profilesSchema = Type.Object(
	{
		open: denseArray(profileSchema),
		copy: denseArray(profileSchema)
	},
	{ additionalProperties: false }
);

export const providerUnavailabilitySchema = Type.Object(
	{
		kind: Type.Literal('unsupported-platform'),
		platform: nonEmptyStringSchema,
		message: nonEmptyStringSchema
	},
	{ additionalProperties: false }
);

export type SandboxProviderUnavailability = Readonly<
	Static<typeof providerUnavailabilitySchema>
>;

export const providerInfoSchema = Type.Refine(
	Type.Object({
		id: nonEmptyStringSchema,
		label: nonEmptyStringSchema,
		profiles: profilesSchema,
		unavailable: Type.Optional(providerUnavailabilitySchema)
	}),
	({ profiles, unavailable }) => {
		return unavailable === undefined
			? profiles.open.length > 0 &&
					new Set(profiles.open.map((profile) => profileKey(profile))).size ===
						profiles.open.length &&
					new Set(profiles.copy.map((profile) => profileKey(profile))).size ===
						profiles.copy.length &&
					profiles.copy.every((profile) => !profile.policy.hostWorkspaceWrites)
			: profiles.open.length === 0 && profiles.copy.length === 0;
	}
);
