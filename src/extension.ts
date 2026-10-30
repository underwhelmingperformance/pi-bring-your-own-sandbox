import type { ExtensionAPI } from '@earendil-works/pi-coding-agent';

/**
Registers the scaffold's `/byos` status command with Pi. The broker and
execution backends remain implementation work.
*/
export default function sandboxExtension(pi: ExtensionAPI): void {
	pi.registerCommand('byos', {
		description: 'Show the sandbox framework scaffold status',
		handler(_arguments, context) {
			context.ui.notify(
				'The sandbox framework is not implemented yet. See docs/specification.md.',
				'info'
			);

			return Promise.resolve();
		}
	});
}
