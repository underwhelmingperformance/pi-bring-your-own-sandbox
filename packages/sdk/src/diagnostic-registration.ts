import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { isApprovalError } from './approval-errors.js';
import { ensureSandboxService } from './default-broker.js';
import {
	formatProviderDiagnostics,
	formatProviders,
	formatStatus
} from './diagnostics.js';
import type { DisplayText } from './display-text.js';
import { cleanDisplayText, joinDisplayLines } from './display-text.js';
import { sendDisplayMessage } from './display-ui.js';
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
export function registerSandboxDiagnostics(pi: ExtensionAPI): void {
	const service = ensureSandboxService(pi);

	pi.registerCommand('byos', {
		description: 'Show sandbox and approval status or available services',
		async handler(arguments_, context) {
			const action = arguments_.trim();

			if (!['', 'status', 'providers', 'approval-policies'].includes(action)) {
				sendDisplayMessage(
					pi,
					cleanDisplayText('byos'),
					cleanDisplayText(
						'Usage: /byos status | /byos providers | /byos approval-policies'
					)
				);

				return;
			}

			let lines: DisplayText[];

			try {
				if (action === 'approval-policies') {
					lines = [
						'Available execution approval policies:',
						...approvalService(pi)
							.policies()
							.map((policy) => `${policy.id}: ${policy.label}`)
					].map((line) => cleanDisplayText(line));
				} else if (action === 'providers') {
					lines = [formatProviders(await service.providers(context))];
				} else {
					const status = await service.status(context);

					lines = [formatStatus(status)];

					const outside = await outsideExecutionStatus(pi, context);
					const warnings =
						outside === undefined ? [] : formatProviderDiagnostics(outside);

					if (warnings.length > 0) {
						lines.push(
							cleanDisplayText('Outside execution diagnostics:'),
							...warnings
						);
					}

					try {
						const settings = runtimeSettings(pi);
						const config = await settings.read(context);
						const policies = approvalService(pi).policies();
						const selected = config.approval?.policy ?? 'user';
						const isAvailable = policies.some(
							(policy) => policy.id === selected
						);
						const destination = config.outsideSandbox?.destination ?? 'normal';

						lines.push(
							cleanDisplayText(
								`Approval policy: ${selected}${isAvailable ? '' : ' (unavailable)'}`
							),
							cleanDisplayText(
								`Outside execution destination: ${destination}${destination === 'provider' ? ` (${config.selection.providerId})` : settings.normalExecutor === undefined ? '' : ` (${settings.normalExecutor.label})`}`
							)
						);

						if (
							destination === 'normal' &&
							settings.normalExecutor === undefined
						) {
							lines.push(
								cleanDisplayText(
									'Outside native Pi shell termination scope: none'
								)
							);
						} else if (outside?.capabilities !== undefined) {
							lines.push(
								cleanDisplayText(
									`Outside shell termination scope: ${outside.capabilities.terminationScope}`
								)
							);
						}
					} catch (error) {
						if (!isSandboxError(error) && !isApprovalError(error)) {
							throw error;
						}

						lines.push(
							cleanDisplayText(
								`Execution settings: ${error.name}: ${error.message}`
							)
						);
					}
				}
			} catch (error) {
				if (!isSandboxError(error) && !isApprovalError(error)) {
					throw new SandboxInitialisationError(
						{ operation: 'configure' },
						{ cause: error }
					);
				}

				lines = [cleanDisplayText(`${error.name}: ${error.message}`)];
			}

			if (action !== 'providers' && action !== 'approval-policies') {
				lines.push(cleanDisplayText(describeShellIntegration(pi.events)));
			}

			sendDisplayMessage(pi, cleanDisplayText('byos'), joinDisplayLines(lines));
		}
	});
}
