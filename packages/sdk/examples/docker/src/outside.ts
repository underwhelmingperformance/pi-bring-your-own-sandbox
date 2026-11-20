import type { OutsideSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import { dockerConfig } from './config.js';
import type { DockerConfig } from './contracts.js';
import type { DockerProviderOptions } from './provider.js';
import { createDockerProvider } from './provider.js';

/**
Provide a separate writable Docker copy for approved outside execution.
The configured daemon must have access to the source checkout.
*/
export function createDockerOutsideDestination(
	config: DockerConfig,
	options: DockerProviderOptions = {}
): OutsideSandboxProvider<DockerConfig> {
	const connection = dockerConfig(config);
	const provider = createDockerProvider(options);

	return {
		label: 'Separate writable Docker workspace',
		capabilities: provider.capabilities,
		policy: {
			workspaceRelationship: 'copied',
			workspaceAccess: 'read-write',
			filesystemScope: 'workspace-only',
			networkAccess: 'denied'
		},
		open: (request, context) =>
			provider.open({ ...request, configuration: connection }, context)
	};
}
