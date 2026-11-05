import type { ProcessOutput } from 'pi-bring-your-own-sandbox/api';
import { expect, it } from 'vitest';

import { LaunchFrames } from '../src/frames.js';

const encode = (text: string) => new TextEncoder().encode(text);

it('decodes split frames and preserves binary stdout, stderr and target signal status', () => {
	const output: ProcessOutput[] = [];
	const frames = new LaunchFrames(
		(chunk) => {
			output.push({ stream: chunk.stream, data: new Uint8Array(chunk.data) });
		},
		{ kind: 'none' }
	);
	const data =
		[
			JSON.stringify({
				kind: 'stdout',
				data: Buffer.from([0, 255, 10]).toString('base64')
			}),
			JSON.stringify({
				kind: 'stderr',
				data: Buffer.from('error').toString('base64')
			}),
			JSON.stringify({
				kind: 'exited',
				exit: { kind: 'signal', signal: 'SIGTERM', signalNumber: 15 }
			})
		].join('\n') + '\n';

	for (const character of data) {
		frames.accept({ stream: 'stdout', data: encode(character) });
	}

	expect({ output, outcome: frames.finish() }).toStrictEqual({
		output: [
			{ stream: 'stdout', data: new Uint8Array([0, 255, 10]) },
			{ stream: 'stderr', data: encode('error') }
		],
		outcome: {
			kind: 'exited',
			exit: { kind: 'signal', signal: 'SIGTERM', signalNumber: 15 }
		}
	});
});

it.each([
	{ kind: 'not-found', error: 'SandboxPathNotFoundError' },
	{ kind: 'permission-denied', error: 'SandboxPermissionDeniedError' },
	{ kind: 'start-failed', error: 'SandboxOperationError' }
])('translates $kind into a typed SDK error', ({ kind, error }) => {
	const frames = new LaunchFrames(
		() => {
			throw new Error('No output was expected.');
		},
		{ kind: 'none' }
	);

	frames.accept({
		stream: 'stdout',
		data: encode(JSON.stringify({ kind }) + '\n')
	});
	expect(() => frames.finish()).toThrow(
		expect.objectContaining({ name: error })
	);
});

it.each([
	'not JSON\n',
	'{"kind":"stdout","data":"not base64"}\n',
	'{"kind":"exited","exit":{"kind":"signal","signal":"SIGTERM"}}\n',
	'{"kind":"exited","exit":{"kind":"code","code":0}}\n{"kind":"stdout","data":""}\n',
	'x'.repeat(262_145)
])('rejects malformed launcher output without forwarding it: %s', (data) => {
	const output: ProcessOutput[] = [];
	const frames = new LaunchFrames(
		(chunk) => {
			output.push({ stream: chunk.stream, data: new Uint8Array(chunk.data) });
		},
		{ kind: 'none' }
	);

	expect(() => {
		frames.accept({ stream: 'stdout', data: encode(data) });
	}).toThrow();
	expect(output).toStrictEqual([]);
});

it('requires a complete final frame before accepting completion', () => {
	const frames = new LaunchFrames(
		() => {
			return;
		},
		{ kind: 'none' }
	);

	frames.accept({
		stream: 'stdout',
		data: encode('{"kind":"stdout","data":""}\n')
	});
	expect(() => frames.finish()).toThrow(
		expect.objectContaining({ name: 'SandboxTransportError' })
	);
});
