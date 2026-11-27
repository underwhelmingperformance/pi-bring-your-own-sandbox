import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import sandboxTools from 'pi-bring-your-own-sandbox/pi-tools';
import type { SandboxSharedSettings } from 'pi-bring-your-own-sandbox/provider';

import { registerDockerProvider } from './provider-registration.js';

/**
Registers Docker and the Pi tool integration. Allocation waits until a tool
or another SDK consumer acquires a sandbox.
*/
export default function dockerExtension(
	pi: ExtensionAPI,
	extensionSource = import.meta.filename,
	settings?: SandboxSharedSettings
): void {
	registerDockerProvider(pi, extensionSource, settings);
	sandboxTools(pi, extensionSource);
}
