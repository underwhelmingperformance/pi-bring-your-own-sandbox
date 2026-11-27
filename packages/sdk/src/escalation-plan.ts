import type {
	PathGrants,
	Sandbox,
	SandboxCloseReport,
	SandboxContext,
	SandboxOperationOptions,
	SandboxPolicy
} from './contracts.js';
import { describeHostUserData } from './credential-locations.js';
import type { EscalationDestination } from './escalation-ledger.js';

export interface EscalatedSandbox {
	readonly sandbox: Sandbox;
	readonly close: () => Promise<SandboxCloseReport>;
}

export interface EscalationPlan {
	readonly label: string;
	readonly destination: EscalationDestination;
	readonly paths?: PathGrants;
	readonly readApproval?: {
		readonly paths: readonly string[];
		readonly coversRequest: boolean;
		readonly persistence?: {
			readonly paths: readonly string[];
			readonly save: (signal: AbortSignal) => Promise<string>;
		};
	};
	readonly assertCurrent: (context: SandboxContext) => void;
	readonly open: (
		context: SandboxContext,
		options?: SandboxOperationOptions
	) => Promise<EscalatedSandbox>;
}

export function describeRestrictions(
	policy: SandboxPolicy,
	{
		paths,
		hostUserDataRoots = [],
		isUnrestrictedHost = false
	}: {
		readonly paths?: PathGrants;
		readonly hostUserDataRoots?: readonly string[];
		readonly isUnrestrictedHost?: boolean;
	} = {}
): string {
	if (isUnrestrictedHost) {
		return 'none';
	}

	const read = paths?.read;
	const write = paths?.write;

	return [
		`Host workspace writes ${policy.hostWorkspaceWrites ? 'allowed' : 'denied'}`,
		`network ${policy.network ? 'allowed' : 'denied'}`,
		`host user data ${describeHostUserData(policy.hostUserData, false)}`,
		`host system files ${policy.hostSystemFiles}`,
		...(policy.hostUserData === 'denied'
			? []
			: [`host user data roots ${JSON.stringify(hostUserDataRoots)}`]),
		...(read === undefined || read.length === 0
			? []
			: [`read grants ${JSON.stringify(read)}`]),
		...(write === undefined || write.length === 0
			? []
			: [`write grants ${JSON.stringify(write)}`])
	].join(', ');
}
