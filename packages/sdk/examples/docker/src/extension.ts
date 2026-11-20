import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import type { DockerConfig } from './contracts.js';
import { createDockerProvider } from './provider.js';

/**
Registers the Docker example; allocation waits until a consumer acquires it.
*/
export default function dockerExtension(pi: ExtensionAPI): void {
	pi.registerFlag('byos-docker-copy', {
		description: 'Work in a private copy of the checkout.',
		type: 'boolean'
	});
	registerSandboxProvider<DockerConfig, Partial<DockerConfig>>(
		pi,
		createDockerProvider(),
		{
			configure({ pi: session }) {
				const isShared =
					session.isProjectTrusted?.() === true &&
					pi.getFlag('byos-docker-copy') !== true;

				return {
					configuration: {
						defaultWorkspaceRelationship: isShared ? 'shared' : 'copied'
					}
				};
			}
		}
	);
}
