import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerShellOnlyTools } from 'pi-bring-your-own-sandbox/pi-tools';

import dockerExtension from './extension.js';

/**
Load with Pi's Bash tool selected for a Docker development session.
*/
export default function dockerShellProfile(pi: ExtensionAPI): void {
	dockerExtension(pi, import.meta.filename, {
		policy: {
			hostWorkspaceWrites: true,
			network: false,
			hostUserData: 'denied',
			hostSystemFiles: 'denied'
		}
	});
	registerShellOnlyTools(pi, import.meta.filename);
}
