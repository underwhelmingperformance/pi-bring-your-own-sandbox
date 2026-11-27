import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import type { SandboxSharedSettings } from 'pi-bring-your-own-sandbox/provider';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/provider';
import {
	cleanDisplayText,
	sendDisplayMessage
} from 'pi-bring-your-own-sandbox/provider-kit';

import { dockerProvider } from './provider.js';

export function registerDockerProvider(
	pi: ExtensionAPI,
	extensionSource: string,
	settings?: SandboxSharedSettings
): void {
	const declaration = dockerProvider();

	registerSandboxProvider(pi, extensionSource, {
		...declaration,
		create() {
			const implementation = declaration.create();

			return {
				...implementation,
				async configure(context, schema) {
					const configured = await implementation.configure(context, schema);

					return {
						...configured,
						...(settings !== undefined && { settings })
					};
				},
				open(request, context) {
					return implementation.open(request, {
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
		}
	});
}
