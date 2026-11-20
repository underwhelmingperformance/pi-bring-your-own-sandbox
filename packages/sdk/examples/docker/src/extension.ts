import type {
	ExtensionAPI,
	ExtensionContext
} from '@earendil-works/pi-coding-agent';
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

	let activeSession: ExtensionContext | undefined;
	let hasNotified = false;

	pi.on('session_start', (_event, context) => {
		activeSession = context;
	});
	pi.on('session_shutdown', () => {
		activeSession = undefined;
		hasNotified = false;
	});

	const provider = createDockerProvider({
		notifyWorkspaceUnavailable(message) {
			if (hasNotified) {
				return;
			}

			if (activeSession?.hasUI === true) {
				activeSession.ui.notify(message, 'warning');
			} else {
				process.stderr.write(message + '\n');
			}

			hasNotified = true;
		}
	});

	registerSandboxProvider<DockerConfig, Partial<DockerConfig>>(pi, provider, {
		configure({ pi: session }) {
			const isTrusted =
				activeSession?.sessionManager.getSessionId() ===
					session.sessionManager.getSessionId() &&
				activeSession.cwd === session.cwd
					? activeSession.isProjectTrusted()
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
