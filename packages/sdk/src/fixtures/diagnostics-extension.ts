import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerSandboxDiagnostics } from '../diagnostic-registration.js';

export default function diagnosticsExtension(pi: ExtensionAPI): void {
	registerSandboxDiagnostics(pi, import.meta.filename);
}
