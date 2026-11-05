import type { ExtensionContext } from '@earendil-works/pi-coding-agent';
import type { Static } from 'typebox';

import type { approvalDecisionSchema } from './approval-schemas.js';
import type {
	ProcessOptions,
	ProcessRequest,
	ProcessResult,
	SandboxBackend,
	SandboxCapabilities,
	SandboxCleanupBudgets,
	SandboxOpenContext,
	SandboxOpenRequest,
	SandboxOperationContext,
	SandboxPolicy,
	SandboxWorkspace
} from './contracts.js';

/**
Describes the environment in which an approved process will execute.
*/
export interface ExecutionDestination {
	/**
	Identifies the route selected through extension-owned configuration.
	*/
	readonly kind: 'normal' | 'provider';
	/**
	Backend identity for this resolved execution destination.
	*/
	readonly id: string;
	/**
	Description suitable for confirmation dialogues and policy enumeration.
	*/
	readonly label: string;
	/**
	Target paths and their relationship to the Pi workspace.
	*/
	readonly workspace: SandboxWorkspace;
	/**
	Explains the effective restrictions of this execution destination.
	*/
	readonly policyDescription: string;
}

/**
Concrete process and destination supplied to the selected approval policy.
*/
export interface ExecutionApprovalRequest {
	/**
	Exact command, target working directory and explicit environment overrides.
	*/
	readonly process: ProcessRequest;
	/**
	Resolved environment to which this decision or executor applies.
	*/
	readonly destination: ExecutionDestination;
	/**
	Non-empty explanation presented to the selected approval policy.
	*/
	readonly justification: string;
}

/**
A decision applies only to the submitted operation and destination.
*/
export type ApprovalDecision = Readonly<Static<typeof approvalDecisionSchema>>;

/**
Live application context and the bounded lifetime of one review.
*/
export interface ApprovalContext extends SandboxOperationContext {
	/**
	Live Pi context for policies that inspect conversation evidence or show UI.
	*/
	readonly pi: ExtensionContext;
}

/**
Independent execution approval implementation. Validation must not allocate
resources; decide may inspect the live Pi context but must respect its signal.
@typeParam Config - Validated policy-specific configuration.
*/
export interface ApprovalPolicy<Config> {
	/**
	Policy ID used for discovery and approval selection.
	*/
	readonly id: string;
	/**
	Description suitable for confirmation dialogues and policy enumeration.
	*/
	readonly label: string;
	/**
	Version of the policy registration contract understood by the framework.
	*/
	readonly protocolVersion: 1;
	/**
	Validate approval policy configuration synchronously without allocating resources.
	*/
	readonly validateConfig: (input: unknown) => Config;
	/**
	Review one immutable operation; returning a decision does not execute it.
	*/
	readonly decide: (
		request: ExecutionApprovalRequest,
		context: ApprovalContext,
		config: Config
	) => Promise<ApprovalDecision>;
}

/**
Execution environment supplied by a sandbox provider or embedding host.
*/
export interface OutsideSandboxProvider<Config> {
	/**
	Description suitable for confirmation dialogues and policy enumeration.
	*/
	readonly label: string;
	/**
	Available process and shell capabilities of the execution backend.
	*/
	readonly capabilities: SandboxCapabilities;
	/**
	Required protections for this provider-defined execution environment.
	*/
	readonly policy: SandboxPolicy;
	/**
	Allocate the outside destination with the provider's validated configuration.
	*/
	readonly open: (
		request: SandboxOpenRequest<Config>,
		context: SandboxOpenContext
	) => Promise<SandboxBackend>;
}

/**
Settings for one approved invocation, including streaming and cancellation.
*/
export interface OutsideSandboxProcessOptions extends ProcessOptions {
	/**
	Non-empty explanation presented to the selected approval policy.
	*/
	readonly justification: string;
}

/**
Generation-scoped execution destination. Inspect workspace paths before building
a request. Each exec call obtains a fresh decision from the selected policy.
*/
export interface OutsideSandboxExecutor {
	/**
	Effective cleanup budgets for this execution destination.
	*/
	readonly cleanupBudgets: SandboxCleanupBudgets;
	/**
	Resolved environment to which this decision or executor applies.
	*/
	readonly destination: ExecutionDestination;
	/**
	Available process and shell capabilities of the execution backend.
	*/
	readonly capabilities: SandboxCapabilities;
	/**
	Obtain a fresh approval, then execute the reviewed request within one deadline.
	*/
	readonly exec: (
		request: ProcessRequest,
		options: OutsideSandboxProcessOptions
	) => Promise<ProcessResult>;
}

/**
Personal policy selection; registration alone never selects a policy.
*/
export interface ApprovalSelection {
	/**
	Registered policy ID; omitted approval settings select the built-in user policy.
	*/
	readonly policy: string;
	/**
	Policy-specific input forwarded unchanged to the validator.
	*/
	readonly config?: unknown;
}

/**
Policy identity and description available without starting a review.
*/
export interface ApprovalPolicyInfo {
	/**
	Registered identity used by approval selection.
	*/
	readonly id: string;
	/**
	Human-readable description displayed when policies are enumerated.
	*/
	readonly label: string;
}
