import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';
import * as sandboxClient from 'pi-bring-your-own-sandbox/api';

import { inspectWorkspace } from './workspace.js';

/**
Registers a tool that executes through the user's selected sandbox provider.
*/
export default function workspaceExtension(pi: ExtensionAPI): void {
	pi.registerTool({
		name: 'sandbox_pwd',
		label: 'Sandbox working directory',
		description:
			'Run pwd in the selected sandbox and report its output and exit status.',
		parameters: { type: 'object', properties: {}, additionalProperties: false },
		async execute(_id, _input, signal, _onUpdate, context) {
			const result = await inspectWorkspace(sandboxClient, pi, context, signal);
			const output = {
				exit: result.exit,
				stdout: new TextDecoder().decode(result.stdout),
				stderr: new TextDecoder().decode(result.stderr),
				omittedBytes: result.omittedBytes
			};

			return {
				content: [{ type: 'text', text: JSON.stringify(output) }],
				details: output
			};
		}
	});
}
