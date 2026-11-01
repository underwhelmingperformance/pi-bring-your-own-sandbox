import { Type } from 'typebox';

import { workspaceSchema } from './backend-schemas.js';
import {
	processOptionsSchema,
	processRequestSchema
} from './request-schemas.js';
import { nonEmptyStringSchema, safeTextSchema } from './schemas.js';

export const justificationSchema = Type.Refine(
	safeTextSchema,
	(value) => value.trim().length > 0
);

export const approvalDecisionSchema = Type.Object(
	{ kind: Type.Enum(['allow', 'deny']) },
	{ additionalProperties: false }
);

export const executionDestinationSchema = Type.Object(
	{
		kind: Type.Enum(['normal', 'provider']),
		id: nonEmptyStringSchema,
		label: nonEmptyStringSchema,
		workspace: workspaceSchema,
		policyDescription: nonEmptyStringSchema
	},
	{ additionalProperties: false }
);

export const executionApprovalRequestSchema = Type.Object(
	{
		process: processRequestSchema,
		destination: executionDestinationSchema,
		justification: justificationSchema
	},
	{ additionalProperties: false }
);

export const outsideProcessOptionsSchema = Type.Object(
	{
		...processOptionsSchema.properties,
		justification: justificationSchema
	},
	{ additionalProperties: false }
);

export const approvalErrorNameSchema = Type.Enum([
	'ApprovalDeniedError',
	'ApprovalUnavailableError',
	'ApprovalPolicyNotFoundError',
	'DuplicateApprovalPolicyError',
	'ApprovalPolicyError',
	'InvalidApprovalRequestError'
]);

export const approvalErrorSchema = Type.Object({
	approvalErrorVersion: Type.Literal(1),
	name: approvalErrorNameSchema,
	message: Type.String()
});
