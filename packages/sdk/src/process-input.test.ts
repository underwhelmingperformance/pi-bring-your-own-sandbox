import { expect, it } from 'vitest';

import { InvalidSandboxRequestError } from './errors.js';
import {
	snapshotProcessOptions,
	snapshotProcessRequest
} from './process-input.js';

const sparseArguments: string[] = [];

sparseArguments.length = 1;

it.each([
	undefined,
	{ kind: 'argv', executable: '', args: [] },
	{ kind: 'argv', executable: 'program', args: ['argument\0'] },
	{ kind: 'argv', executable: 'program', args: sparseArguments },
	{ kind: 'argv', executable: 'program', args: [], command: 'unexpected' },
	{ kind: 'shell', command: 'command' },
	{ kind: 'shell', command: 'command', dialect: 'fish' },
	{ kind: 'shell', command: 'command\0', dialect: 'sh' },
	{ kind: 'shell', command: 'command', dialect: 'sh', cwd: '' },
	{ kind: 'shell', command: 'command', dialect: 'sh', env: { 'A=B': 'bad' } },
	{ kind: 'shell', command: 'command', dialect: 'sh', env: { A: 1 } }
])(
	'rejects invalid process requests before a provider can receive them: %j',
	(input) => {
		expect(() => snapshotProcessRequest(input)).toThrow(
			InvalidSandboxRequestError
		);
	}
);

it.each([
	{ timeoutMs: 0 },
	{ timeoutMs: Infinity },
	{ maxCaptureBytes: -1 },
	{ maxCaptureBytes: 1_048_577 },
	{ maxCaptureBytes: 0.5 },
	{ onOutput: 'callback' },
	{ signal: { aborted: false } },
	{ unsupported: true }
])('rejects invalid execution options: %j', (input) => {
	expect(() => snapshotProcessOptions(input)).toThrow(
		InvalidSandboxRequestError
	);
});

it('preserves empty arguments, explicit environment deletion and an empty shell command', () => {
	const environment: unknown = JSON.parse('{"DELETE":null,"EMPTY":""}');

	expect([
		snapshotProcessRequest({
			kind: 'argv',
			executable: 'program',
			args: ['', 'same', 'same'],
			env: environment
		}),
		snapshotProcessRequest({ kind: 'shell', command: '', dialect: 'sh' }),
		snapshotProcessOptions(undefined)
	]).toStrictEqual([
		{
			kind: 'argv',
			executable: 'program',
			args: ['', 'same', 'same'],
			env: environment
		},
		{ kind: 'shell', command: '', dialect: 'sh' },
		{}
	]);
});
