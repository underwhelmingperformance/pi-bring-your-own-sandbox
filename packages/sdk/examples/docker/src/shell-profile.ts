import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxRequirement } from 'pi-bring-your-own-sandbox/api';
import { registerShellOnlyTools } from 'pi-bring-your-own-sandbox/pi-tools';

import dockerExtension from './extension.js';

/**
Load with Pi's Bash tool selected for a Docker development session.
*/
export default function dockerShellProfile(pi: ExtensionAPI): void {
	dockerExtension(pi);
	registerSandboxRequirement(pi, {
		providerId: 'example.docker',
		capabilities: ['exec'],
		shells: ['bash'],
		processKinds: ['shell'],
		guarantees: ['no-network', 'no-host-user-data', 'no-host-system-files']
	});
	registerShellOnlyTools(pi, import.meta.filename);
}
