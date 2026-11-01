import type { Static } from 'typebox';

import {
	approvalErrorNameSchema,
	approvalErrorSchema
} from './approval-schemas.js';
import { checker } from './schemas.js';

type ApprovalErrorName = Static<typeof approvalErrorNameSchema>;

/**
Base for structurally identifiable approval failures across installed SDK copies.
*/
export abstract class ApprovalError<
	Name extends ApprovalErrorName = ApprovalErrorName
> extends Error {
	/**
	Version of the structural approval error contract.
	*/
	readonly approvalErrorVersion = 1;
	/**
	Stable class identity used across SDK copies.
	*/
	override readonly name: Name;

	protected constructor(name: Name, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = name;
	}
}

/**
The configured policy rejected this operation.
*/
export class ApprovalDeniedError extends ApprovalError<'ApprovalDeniedError'> {
	constructor() {
		super(
			'ApprovalDeniedError',
			'Execution was denied by the selected approval policy.'
		);
	}
}

/**
The requested policy cannot obtain a decision in this runtime.
*/
export class ApprovalUnavailableError extends ApprovalError<'ApprovalUnavailableError'> {
	constructor() {
		super(
			'ApprovalUnavailableError',
			'The selected approval policy is unavailable. User approval requires a Pi UI that supports confirmation prompts.'
		);
	}
}

/**
An extension returned an invalid declaration or failed during review.
*/
export class ApprovalPolicyError extends ApprovalError<'ApprovalPolicyError'> {
	constructor(options?: ErrorOptions) {
		super(
			'ApprovalPolicyError',
			'The approval policy failed or returned an invalid decision.',
			options
		);
	}
}

/**
An approval input violates the execution request contract.
*/
export class InvalidApprovalRequestError extends ApprovalError<'InvalidApprovalRequestError'> {
	constructor(options?: ErrorOptions) {
		super(
			'InvalidApprovalRequestError',
			'Provide a valid execution destination, process and non-empty justification.',
			options
		);
	}
}

const isApprovalFailure = checker(approvalErrorSchema);

/**
Recognises approval failures without relying on constructor identity.
*/
export function isApprovalError(value: unknown): value is ApprovalError {
	return isApprovalFailure(value);
}

/**
Personal configuration selects a policy that no loaded extension provides.
*/
export class ApprovalPolicyNotFoundError extends ApprovalError<'ApprovalPolicyNotFoundError'> {
	constructor() {
		super(
			'ApprovalPolicyNotFoundError',
			'The configured approval policy is not registered. Check approval.policy in personal byos.json.'
		);
	}
}

/**
Multiple loaded extensions registered the same approval policy identity.
*/
export class DuplicateApprovalPolicyError extends ApprovalError<'DuplicateApprovalPolicyError'> {
	constructor() {
		super(
			'DuplicateApprovalPolicyError',
			'Approval policy IDs must be unique, including the built-in user, always and never policies.'
		);
	}
}
