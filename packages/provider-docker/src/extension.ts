import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SandboxSharedSettings } from 'pi-bring-your-own-sandbox/provider';
import {
	cleanDisplayText,
	registerSandboxProvider,
	sendDisplayMessage
} from 'pi-bring-your-own-sandbox/provider';

import { resolveDockerConfig } from './config.js';
import type { DockerConfig } from './contracts.js';
import { createDockerProvider } from './provider.js';

/**
Registers the Docker example; allocation waits until a consumer acquires it.
Each session uses the Docker CLI and daemon that are current when it starts.
*/
export default function dockerExtension(
	pi: ExtensionAPI,
	extensionSource = import.meta.filename,
	settings?: SandboxSharedSettings
): void {
	const provider = createDockerProvider();

	registerSandboxProvider<DockerConfig>(
		pi,
		extensionSource,
		{
			...provider,
			open(request, context) {
				return provider.open(request, {
					...context,
					reportDiagnostic(warning) {
						context.reportDiagnostic(warning);
						sendDisplayMessage(
							pi,
							cleanDisplayText('byos-docker'),
							cleanDisplayText(warning.message),
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
					...(settings !== undefined && { settings })
				};
			}
		}
	);
}
