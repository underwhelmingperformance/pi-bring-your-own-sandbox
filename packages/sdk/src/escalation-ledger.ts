import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';
import { Type } from 'typebox';

import { workspaceSchema } from './backend-schemas.js';
import type { SandboxHost } from './contracts.js';
import type { DisplayText } from './display-text.js';
import {
	cleanDisplayText,
	cleanFullDisplayText,
	joinFullDisplayLines
} from './display-text.js';
import { appendTypedEntry } from './display-ui.js';
import { InvalidSandboxDeclarationError } from './errors.js';
import { accessPolicySchema, accessSchema } from './policy-model.js';
import {
	checker,
	denseArray,
	nonEmptyStringSchema,
	safeTextSchema
} from './schemas.js';

type ReadonlyData<Value> = Value extends object
	? { readonly [Key in keyof Value]: ReadonlyData<Value[Key]> }
	: Value;

const destinationFields = { policy: accessPolicySchema };
const destinationSchema = Type.Union([
	Type.Object(
		{
			...destinationFields,
			kind: Type.Literal('provider'),
			providerId: nonEmptyStringSchema,
			effectiveRestrictions: nonEmptyStringSchema
		},
		{ additionalProperties: false }
	),
	Type.Object(
		{
			...destinationFields,
			kind: Type.Literal('host'),
			effectiveRestrictions: Type.Literal('none')
		},
		{ additionalProperties: false }
	)
]);

export type EscalationDestination = ReadonlyData<
	Static<typeof destinationSchema>
>;

const requestFields = {
	toolCallId: nonEmptyStringSchema,
	command: safeTextSchema,
	justification: nonEmptyStringSchema,
	access: accessSchema
};

export const escalationRequestSchema = Type.Object(
	{ ...requestFields, destination: destinationSchema },
	{ additionalProperties: false }
);

export type EscalationRequest = ReadonlyData<
	Static<typeof escalationRequestSchema>
>;

const isEscalationRequest = checker(escalationRequestSchema);

export type EscalationDecision = 'allow' | 'deny';

export function snapshotEscalationRequest(
	request: EscalationRequest
): EscalationRequest {
	if (!isEscalationRequest(request)) {
		throw new InvalidSandboxDeclarationError({ operation: 'acquire' });
	}

	const { paths, ...access } = request.access;
	const grants =
		paths === undefined
			? undefined
			: Object.freeze({
					...(paths.read !== undefined && {
						read: Object.freeze([...paths.read])
					}),
					...(paths.write !== undefined && {
						write: Object.freeze([...paths.write])
					})
				});
	const destination = Object.freeze({
		...request.destination,
		policy: Object.freeze({ ...request.destination.policy })
	});

	return Object.freeze({
		...request,
		access: Object.freeze({
			...access,
			...(grants !== undefined && { paths: grants })
		}),
		destination
	});
}

const permissionDecider = Type.Object({
	kind: Type.Literal('permission-extension'),
	extension: nonEmptyStringSchema
});
const confirmationDecider = Type.Object({ kind: Type.Literal('confirmation') });
const configDecider = Type.Object({
	kind: Type.Literal('configuration')
});
const rememberedReads = Type.Object({
	kind: Type.Literal('remembered-read'),
	toolCallIds: denseArray(nonEmptyStringSchema)
});
const decider = Type.Union([
	confirmationDecider,
	permissionDecider,
	configDecider,
	rememberedReads
]);
const escalation = Type.Object({
	kind: Type.Literal('escalation'),
	request: Type.Object({
		...requestFields,
		destination: Type.Optional(destinationSchema)
	}),
	outcome: Type.Enum(['allowed', 'denied', 'cancelled', 'expired']),
	decider: Type.Optional(decider)
});

export const destinationDescriptionSchema = Type.Object({
	providerId: nonEmptyStringSchema,
	label: nonEmptyStringSchema,
	workspace: Type.Optional(workspaceSchema),
	policy: accessPolicySchema
});

export type DestinationDescription = ReadonlyData<
	Static<typeof destinationDescriptionSchema>
>;

const reviewCopy = Type.Object({
	kind: Type.Literal('review-copy'),
	toolCallId: nonEmptyStringSchema,
	source: destinationDescriptionSchema,
	policy: accessPolicySchema,
	decider: permissionDecider
});

export const ledgerEntrySchema = Type.Union([escalation, reviewCopy]);

export type SandboxLedgerEntry = ReadonlyData<Static<typeof ledgerEntrySchema>>;
export type EscalationEntry = Extract<
	SandboxLedgerEntry,
	{ kind: 'escalation' }
>;

const customType = 'byos.ledger';
const isLedgerEntry = checker(ledgerEntrySchema);
const historicalViolationDetail = Type.Object({
	operation: nonEmptyStringSchema,
	accessProperty: Type.KeyOf(accessPolicySchema),
	resource: Type.Optional(Type.String())
});
const isHistoricalViolation = checker(
	Type.Object({
		kind: Type.Literal('violation'),
		toolCallId: Type.Optional(nonEmptyStringSchema),
		operationId: nonEmptyStringSchema,
		providerId: nonEmptyStringSchema,
		violations: denseArray(historicalViolationDetail)
	})
);

interface OwnEntry {
	readonly sessionId: string;
	readonly text: string;
}

const ownEntries = new WeakMap<object, OwnEntry>();

export function appendLedgerEntry(
	pi: SandboxHost,
	sessionId: string,
	entry: SandboxLedgerEntry
): void {
	const data = structuredClone(entry);

	ownEntries.set(data, { sessionId, text: JSON.stringify(data) });
	appendTypedEntry(pi, cleanDisplayText(customType), data);
}

export function formatLedger(
	context: Pick<ExtensionContext, 'sessionManager'>,
	filter?: string
): DisplayText {
	const sessionId = context.sessionManager.getSessionId();
	const shown = new Set<object>();
	const entries = context.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== 'custom' || entry.customType !== customType) {
			return [];
		}

		const data: unknown = entry.data;

		if (!isLedgerEntry(data) && !isHistoricalViolation(data)) {
			return [];
		}

		const toolCallId =
			data.kind === 'escalation' ? data.request.toolCallId : data.toolCallId;

		if (filter !== undefined && filter !== toolCallId) {
			return [];
		}

		try {
			const text = JSON.stringify(data);
			const own = ownEntries.get(data);

			if (own?.sessionId !== sessionId || own.text !== text) {
				return cleanFullDisplayText('Unverified ledger entry ' + text);
			}

			if (shown.has(data)) {
				return [];
			}

			shown.add(data);

			return cleanFullDisplayText(text);
		} catch {
			return [];
		}
	});

	return entries.length === 0
		? cleanDisplayText('No matching BYOS ledger entries in this session.')
		: joinFullDisplayLines(entries);
}
