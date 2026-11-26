import type { Static } from 'typebox';
import { Type } from 'typebox';

import { workspaceSchema } from './backend-schemas.js';
import type { SandboxContext, SandboxHost } from './contracts.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import { appendTypedEntry } from './display-ui.js';
import { accessPolicySchema, accessSchema } from './policy-model.js';
import { violationsSchema } from './result-schemas.js';
import { checker, nonEmptyStringSchema, safeTextSchema } from './schemas.js';

type ReadonlyData<Value> = Value extends object
	? { readonly [Key in keyof Value]: ReadonlyData<Value[Key]> }
	: Value;

const destinationFields = { policy: accessPolicySchema };
const destinationSchema = Type.Union([
	Type.Object({
		...destinationFields,
		kind: Type.Literal('provider'),
		providerId: nonEmptyStringSchema,
		effectiveRestrictions: nonEmptyStringSchema
	}),
	Type.Object({
		...destinationFields,
		kind: Type.Literal('host'),
		effectiveRestrictions: Type.Literal('none')
	})
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
export type EscalationDecision = 'allow' | 'deny';

const permissionDecider = Type.Object({
	kind: Type.Literal('permission-extension'),
	extension: nonEmptyStringSchema
});
const confirmationDecider = Type.Object({ kind: Type.Literal('confirmation') });
const configDecider = Type.Object({
	kind: Type.Literal('configuration')
});
const decider = Type.Union([
	confirmationDecider,
	permissionDecider,
	configDecider
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
const reviewCopy = Type.Object({
	kind: Type.Literal('review-copy'),
	toolCallId: nonEmptyStringSchema,
	source: Type.Object({
		providerId: nonEmptyStringSchema,
		label: nonEmptyStringSchema,
		workspace: workspaceSchema,
		policy: accessPolicySchema
	}),
	policy: accessPolicySchema,
	decider: permissionDecider
});
const violation = Type.Object({
	kind: Type.Literal('violation'),
	toolCallId: Type.Optional(nonEmptyStringSchema),
	operationId: nonEmptyStringSchema,
	providerId: nonEmptyStringSchema,
	violations: violationsSchema
});
const entrySchema = Type.Union([escalation, reviewCopy, violation]);

export type SandboxLedgerEntry = ReadonlyData<Static<typeof entrySchema>>;
export type EscalationEntry = Extract<
	SandboxLedgerEntry,
	{ kind: 'escalation' }
>;

const customType = 'byos.ledger';
const isLedgerEntry = checker(entrySchema);

export const processToolCallId = Symbol.for('pi-byos:ledger-tool-call-id');

export function appendLedgerEntry(
	pi: SandboxHost,
	entry: SandboxLedgerEntry
): void {
	appendTypedEntry(pi, cleanDisplayText(customType), entry);
}

export function formatLedger(
	context: SandboxContext,
	filter?: string
): DisplayText {
	const entries = context.sessionManager.getEntries().flatMap((entry) => {
		if (entry.type !== 'custom' || entry.customType !== customType) {
			return [];
		}

		const data: unknown = entry.data;

		if (!isLedgerEntry(data)) {
			return [];
		}

		const toolCallId =
			data.kind === 'escalation' ? data.request.toolCallId : data.toolCallId;

		return filter === undefined || filter === toolCallId
			? cleanDisplayText(JSON.stringify(data))
			: [];
	});

	return entries.length === 0
		? cleanDisplayText('No matching BYOS ledger entries in this session.')
		: joinDisplayLines(entries);
}
