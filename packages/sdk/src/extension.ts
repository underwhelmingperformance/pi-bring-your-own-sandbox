import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isApprovalError } from './approval-errors.js';
import { ensureSandboxService } from './default-broker.js';
import {
	formatProviderDiagnostics,
	formatProviders,
	formatStatus
} from './diagnostics.js';
import { isSandboxError, SandboxInitialisationError } from './errors.js';
import { approvalService } from './execution-approval.js';
import { outsideExecutionStatus } from './outside-execution.js';
import { describeShellIntegration } from './pi-integration-status.js';
import { runtimeSettings } from './runtime-settings.js';

/**
Register optional sandbox diagnostics. Status and provider enumeration use
the same service as SDK consumers and do not allocate a backend. Loading
this extension preserves Pi's tools and active tool selection.
*/
export default function sandboxExtension(pi: ExtensionAPI): void {
	const service = ensureSandboxService(pi);

	pi.registerCommand('byos', {
		description: 'Show sandbox and approval status or available services',
		async handler(arguments_, context) {
			const action = arguments_.trim();

			if (!['', 'status', 'providers', 'approval-policies'].includes(action)) {
				pi.sendMessage({
					customType: 'byos',
					content:
						'Usage: /byos status | /byos providers | /byos approval-policies',
					display: true
				});

				return;
			}

			let content: string;

			try {
				if (action === 'approval-policies') {
					content = [
						'Available execution approval policies:',
						...approvalService(pi)
							.policies()
							.map((policy) => `${policy.id}: ${policy.label}`)
					].join('\n');
				} else if (action === 'providers') {
					content = formatProviders(await service.providers(context));
				} else {
					const status = await service.status(context);

					content = formatStatus(status);

					const outside = await outsideExecutionStatus(pi, context);
					const warnings =
						outside === undefined ? [] : formatProviderDiagnostics(outside);

					if (warnings.length > 0) {
						content += `\nOutside execution diagnostics:\n${warnings.join('\n')}`;
					}

					try {
						const settings = runtimeSettings(pi);
						const config = await settings.read();
						const policies = approvalService(pi).policies();
						const selected = config.approval?.policy ?? 'user';
						const isAvailable = policies.some(
							(policy) => policy.id === selected
						);
						const destination = config.outsideSandbox?.destination ?? 'normal';

						const selection = [
							`Approval policy: ${selected}${isAvailable ? '' : ' (unavailable)'}`,
							`Outside execution destination: ${destination}${destination === 'provider' ? ` (${config.selection.providerId})` : settings.normalExecutor === undefined ? '' : ` (${settings.normalExecutor.label})`}`
						].join('\n');

						content += `\n${selection}`;

						if (
							destination === 'normal' &&
							settings.normalExecutor === undefined
						) {
							content += '\nOutside native Pi shell termination scope: none';
						} else if (outside?.capabilities !== undefined) {
							content += `\nOutside shell termination scope: ${outside.capabilities.terminationScope}`;
						}
					} catch (error) {
						if (!isSandboxError(error) && !isApprovalError(error)) {
							throw error;
						}

						content += `\nExecution settings: ${error.name}: ${error.message}`;
					}
				}
			} catch (error) {
				if (!isSandboxError(error) && !isApprovalError(error)) {
					throw new SandboxInitialisationError(
						{ operation: 'configure' },
						{ cause: error }
					);
				}

				content = `${error.name}: ${error.message}`;
			}

			if (action !== 'providers' && action !== 'approval-policies') {
				content += `\n${describeShellIntegration(pi.events)}`;
			}

			pi.sendMessage({ customType: 'byos', content, display: true });
		}
	});
}
