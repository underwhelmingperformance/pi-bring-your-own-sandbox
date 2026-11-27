import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SandboxSharedSettings } from 'pi-bring-your-own-sandbox/provider';
import { registerSandboxProviderFactory } from 'pi-bring-your-own-sandbox/provider';
import {
	cleanDisplayText,
	sendDisplayMessage
} from 'pi-bring-your-own-sandbox/provider-kit';

import { resolveDockerConfig } from './config.js';
import type { DockerConfig } from './contracts.js';
import { createDockerProvider, dockerProviderDeclaration } from './provider.js';

export function registerDockerProvider(
	pi: ExtensionAPI,
	extensionSource: string,
	settings?: SandboxSharedSettings
): void {
	registerSandboxProviderFactory<DockerConfig>(
		pi,
		extensionSource,
		dockerProviderDeclaration(),
		() => {
			const provider = createDockerProvider();

			return {
				...provider,
				open(request, context) {
					return provider.open(request, {
						...context,
						reportWarning(warning) {
							context.reportWarning(warning);
							sendDisplayMessage(
								pi,
								cleanDisplayText('byos-docker'),
								cleanDisplayText(warning),
								{ triggerTurn: false }
							);
						}
					});
				}
			};
		},
		{
			async configure({ pi: session, signal, reportWarning }) {
				return {
					configuration: await resolveDockerConfig(
						{},
						{ workspace: session.cwd, signal, reportWarning }
					),
					...(settings !== undefined && { settings })
				};
			}
		}
	);
}
