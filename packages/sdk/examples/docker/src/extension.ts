import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import type { DockerConfig } from './contracts.js';
import { createDockerProvider, dockerDefaultPolicy } from './provider.js';

/**
Registers the Docker example; allocation waits until a consumer acquires it.
*/
export default function dockerExtension(pi: ExtensionAPI): void {
	pi.registerFlag('byos-docker-copy', {
		description: 'Work in a private copy of the checkout.',
		type: 'boolean'
	});

	let sessionTrust: { id: string; cwd: string; trusted: boolean } | undefined;

	pi.on('session_start', (_event, context) => {
		sessionTrust = {
			id: context.sessionManager.getSessionId(),
			cwd: context.cwd,
			trusted: context.isProjectTrusted()
		};
	});
	pi.on('session_shutdown', () => {
		sessionTrust = undefined;
	});

	const provider = createDockerProvider({
		notifyWorkspaceUnavailable(message) {
			pi.sendMessage(
				{ customType: 'byos-docker', display: true, content: message },
				{ triggerTurn: false }
			);
		}
	});

	registerSandboxProvider<DockerConfig, Partial<DockerConfig>>(pi, provider, {
		configure({ pi: session }) {
			const isTrusted =
				sessionTrust?.id === session.sessionManager.getSessionId() &&
				sessionTrust.cwd === session.cwd
					? sessionTrust.trusted
					: session.isProjectTrusted?.() === true;
			const isShared = isTrusted && pi.getFlag('byos-docker-copy') !== true;

			return {
				...(!isShared && {
					policy: {
						...dockerDefaultPolicy,
						workspaceRelationship: 'copied' as const
					}
				}),
				configuration: {
					defaultWorkspaceRelationship: isShared ? 'shared' : 'copied'
				}
			};
		}
	});
}
