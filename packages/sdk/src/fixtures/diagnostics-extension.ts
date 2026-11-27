import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

import { registerSandboxDiagnostics } from '../pi-tools.js';

export default function diagnosticsExtension(pi: ExtensionAPI): void {
	registerSandboxDiagnostics(pi, import.meta.filename);
}
