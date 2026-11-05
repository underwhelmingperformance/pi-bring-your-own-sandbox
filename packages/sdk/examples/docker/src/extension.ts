import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import { registerSandboxProvider } from 'pi-bring-your-own-sandbox/api';

import { createDockerProvider } from './provider.js';

/**
Registers the Docker example; allocation waits until a consumer acquires it.
*/
export default function dockerExtension(pi: ExtensionAPI): void {
	registerSandboxProvider(pi, createDockerProvider());
}
