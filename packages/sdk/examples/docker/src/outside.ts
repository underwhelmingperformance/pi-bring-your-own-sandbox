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
	const [profile] = provider.profiles.copy;

	if (profile === undefined) {
		throw new Error('The Docker provider does not supply a copy profile.');
	}

	const copy = provider.copy;
	const { capabilities, exitStatus, processKinds, shells, terminationScope } =
		profile;

	return {
		label: 'Separate writable Docker workspace',
		capabilities: {
			operations: capabilities,
			exitStatus,
			processKinds,
			shells,
			terminationScope
		},
		policy: profile.policy,
		open: (request, context) =>
			copy(
				{ ...request, configuration: connection, source: { kind: 'host' } },
				context
			)
	};
}
