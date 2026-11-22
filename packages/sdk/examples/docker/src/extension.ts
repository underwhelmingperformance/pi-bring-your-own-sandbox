import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import { resolveDockerConfig } from './config.js';
import type { DockerConfig } from './contracts.js';
import { createDockerProvider } from './provider.js';

/**
Registers the Docker example; allocation waits until a consumer acquires it.
Each session uses the Docker CLI and daemon that are current when it starts.
*/
export default function dockerExtension(pi: ExtensionAPI): void {
	const provider = createDockerProvider();

	registerSandboxProvider<DockerConfig>(
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
			async configure({ pi: session, signal, reportDiagnostic }) {
				return {
					configuration: await resolveDockerConfig(
						{},
						{ workspace: session.cwd, signal, reportDiagnostic }
					),
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
