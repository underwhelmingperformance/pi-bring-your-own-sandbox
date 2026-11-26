import type {
	PathGrants,
	Sandbox,
	SandboxCloseReport,
	SandboxContext,
	SandboxOperationOptions,
	SandboxPolicy
} from './contracts.js';
import type { EscalationDestination } from './escalation-ledger.js';
import { accessOrder, unrestrictedPolicy } from './policy-model.js';

export interface EscalatedSandbox {
	readonly sandbox: Sandbox;
	readonly close: () => Promise<SandboxCloseReport>;
}

export interface EscalationPlan {
	readonly label: string;
	readonly destination: EscalationDestination;
	readonly paths?: PathGrants;
	readonly assertCurrent: (context: SandboxContext) => void;
	readonly open: (
		context: SandboxContext,
		options?: SandboxOperationOptions
	) => Promise<EscalatedSandbox>;
}

export function describeRestrictions(
	policy: SandboxPolicy,
	paths?: PathGrants
): string {
	if (
		accessOrder.every(
			(property) => policy[property] === unrestrictedPolicy[property]
		)
	) {
		return 'none';
	}

	const read = paths?.read;
	const write = paths?.write;

	return [
		`Host workspace writes ${policy.hostWorkspaceWrites ? 'allowed' : 'denied'}`,
		`network ${policy.network ? 'allowed' : 'denied'}`,
		`host user data ${policy.hostUserData}`,
		`host system files ${policy.hostSystemFiles}`,
		...(read === undefined || read.length === 0
			? []
			: [`read grants ${JSON.stringify(read)}`]),
		...(write === undefined || write.length === 0
			? []
			: [`write grants ${JSON.stringify(write)}`])
	].join(', ');
}
