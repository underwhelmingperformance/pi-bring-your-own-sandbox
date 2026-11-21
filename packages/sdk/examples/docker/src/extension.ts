import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import type { DockerConfig } from './contracts.js';
import { createDockerProvider } from './provider.js';

/**
Registers the Docker example; allocation waits until a consumer acquires it.
*/
export default function dockerExtension(pi: ExtensionAPI): void {
	const provider = createDockerProvider();

	registerSandboxProvider<DockerConfig, Partial<DockerConfig>>(
		pi,
		{
			...provider,
			open(request, context) {
				return provider.open(request, {
					...context,
					reportDiagnostic(warning) {
						context.reportDiagnostic(warning);
						pi.sendMessage(
							{
								customType: 'byos-docker',
								content: warning.message,
								display: true
							},
							{ triggerTurn: false }
						);
					}
				});
			}
		},
		{
			configure({ pi: session }) {
				return {
					configuration: {},
					...(session.isProjectTrusted?.() === true && {
						policy: {
							workspaceAccess: 'read-write',
							filesystemScope: 'provider-default',
							networkAccess: 'provider-default'
						} as const
					})
				};
			}
		}
	);
}
