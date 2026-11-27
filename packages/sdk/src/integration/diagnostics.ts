import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { bindFactory, ensureSandboxService } from '../default-broker.js';
import { formatProviders, formatStatus } from '../diagnostics.js';
import type { DisplayText } from '../display-text.js';
import { cleanDisplayText, joinDisplayLines } from '../display-text.js';
import { notifyDisplay, sendDisplayMessage } from '../display-ui.js';
import { isSandboxError, SandboxInitialisationError } from '../errors.js';
import { formatLedger } from '../escalation-ledger.js';
import { describeShellIntegration } from '../pi-integration-status.js';

/**
Register optional sandbox diagnostics. Status and provider enumeration use
the same service as SDK consumers and do not allocate a backend. Loading
this extension preserves Pi's tools and active tool selection.
*/
export function registerSandboxDiagnostics(
	pi: ExtensionAPI,
	extensionSource: string
): void {
	bindFactory(pi, extensionSource);
	pi.on('session_start', async (_event, context) => {
		const status = await ensureSandboxService(pi).status(context);

		if (status.state === 'failed' && status.failure !== undefined) {
			throw status.failure;
		}
	});

	pi.registerCommand('byos', {
		description: 'Show sandbox status, providers or session decisions',
		async handler(arguments_, context) {
			const action = arguments_.trim();
			const [command, filter, ...extra] = action.split(/\s+/u);

			if (command === 'log' && extra.length === 0) {
				notifyDisplay(context, formatLedger(context, filter), 'info');

				return;
			}

			if (!['', 'status', 'providers'].includes(action)) {
				sendDisplayMessage(
					pi,
					cleanDisplayText('byos'),
					cleanDisplayText(
						'Usage: /byos status | /byos providers | /byos log [tool-call-id]'
					)
				);

				return;
			}

			let lines: DisplayText[];

			try {
				const service = ensureSandboxService(pi);

				if (action === 'providers') {
					lines = [formatProviders(await service.providers(context))];
				} else {
					const status = await service.status(context);

					lines = [formatStatus(status)];
				}
			} catch (error) {
				if (!isSandboxError(error)) {
					throw new SandboxInitialisationError(
						{ operation: 'configure' },
						{ cause: error }
					);
				}

				lines = [cleanDisplayText(`${error.name}: ${error.message}`)];
			}

			if (action !== 'providers') {
				lines.push(cleanDisplayText(describeShellIntegration(pi.events)));
			}

			sendDisplayMessage(pi, cleanDisplayText('byos'), joinDisplayLines(lines));
		}
	});
}
