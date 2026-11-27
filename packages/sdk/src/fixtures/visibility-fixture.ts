import { addAbortListener } from 'node:events';

import type { ProcessRequest } from '../contracts.js';
import type { SandboxProviderTestFixture } from '../provider-test-contracts.js';

export function visibilityFixture(
	targetPath: string,
	read: () => Uint8Array,
	write: (bytes: Uint8Array) => void
) {
	let onReplacement: ((bytes: Uint8Array) => void) | undefined;

	return {
		probe(
			kind: ProcessRequest['kind'] = 'argv'
		): NonNullable<SandboxProviderTestFixture['visibility']> {
			const request = (command: string): ProcessRequest =>
				kind === 'shell'
					? { kind: 'shell', dialect: 'sh', command }
					: { kind: 'argv', executable: command, args: [] };

			return {
				targetPath,
				readSource: () => Promise.resolve(read()),
				replaceSource(bytes) {
					write(bytes);
					onReplacement?.(bytes);

					return Promise.resolve();
				},
				readTarget: request('visibility:read'),
				writeTarget: (bytes) =>
					request('visibility:write:' + Buffer.from(bytes).toString('base64')),
				waitForReplacement: (bytes) =>
					request('visibility:wait:' + Buffer.from(bytes).toString('base64'))
			};
		},
		async execute(
			command: unknown,
			output: (bytes: Uint8Array) => void,
			signal: AbortSignal
		): Promise<boolean> {
			if (typeof command !== 'string' || !command.startsWith('visibility:')) {
				return false;
			}

			const [, operation, contents = ''] = command.split(':', 3);

			if (operation === 'read') {
				output(read());

				return true;
			}

			write(Buffer.from(contents, 'base64'));

			if (operation === 'wait') {
				const replacement = Promise.withResolvers<Uint8Array>();

				using _abort = addAbortListener(signal, () => {
					replacement.reject(
						new Error('The visibility fixture was cancelled.')
					);
				});

				onReplacement = replacement.resolve;

				try {
					output(Buffer.from('ready'));
					output(await replacement.promise);
				} finally {
					onReplacement = undefined;
				}
			}

			return true;
		}
	};
}
