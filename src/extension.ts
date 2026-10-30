import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { ensureSandboxService } from './default-broker.js';
import { formatProviders, formatStatus } from './diagnostics.js';
import { isSandboxError, SandboxInitialisationError } from './errors.js';

/**
Register optional sandbox diagnostics. Status and provider enumeration use
the same service as SDK consumers and do not allocate a backend. Loading
this extension preserves Pi's tools and active tool selection.
*/
export default function sandboxExtension(pi: ExtensionAPI): void {
	const service = ensureSandboxService(pi);
	pi.registerCommand('byos', {
		description: 'Show sandbox status or available providers',
		async handler(arguments_, context) {
			const action = arguments_.trim();
			if (!['', 'status', 'providers'].includes(action)) {
				pi.sendMessage({
					customType: 'byos',
					content: 'Usage: /byos status | /byos providers',
					display: true
				});
				return;
			}
			let content: string;
			try {
				content =
					action === 'providers'
						? formatProviders(await service.providers(context))
						: formatStatus(await service.status(context));
			} catch (error) {
				if (!isSandboxError(error)) {
					throw new SandboxInitialisationError(
						{ operation: 'configure' },
						{ cause: error }
					);
				}
				content = `${error.name}: ${error.message}`;
			}
			pi.sendMessage({ customType: 'byos', content, display: true });
		}
	});
}
