import { Duplex, PassThrough } from 'node:stream';

import { expect, it } from 'vitest';

import {
	beginHostRequests,
	hostReply,
	hostRequests
} from '../src/host-channel.js';

function frame(text: string) {
	const bytes = Buffer.from(text);
	const header = Buffer.from([1, 0, 0, 0, 0, 0, 0, 0]);

	header.writeUInt32BE(bytes.length, 4);

	return Buffer.concat([header, bytes]);
}

it('reads workspace requests across Docker frames and socket reads', async () => {
	const bytes = Buffer.concat([
		frame('{"op":'),
		frame('"rename"}\n'),
		frame('{}\n')
	]);
	const channel = Duplex.from([
		bytes.subarray(0, 3),
		bytes.subarray(3, 10),
		bytes.subarray(10)
	]);

	const requests = hostRequests(channel);
	const results = [
		await requests.next(),
		await requests.next(),
		await requests.next()
	];

	expect(results).toStrictEqual([
		{ value: '{"op":"rename"}', done: false },
		{ value: '{}', done: false },
		{ value: undefined, done: true }
	]);
});

it.each([
	['partial header', Buffer.alloc(3)],
	['partial payload', frame('hello\n').subarray(0, 10)],
	['incomplete request', frame('incomplete')],
	['oversized payload', Buffer.from([1, 0, 0, 0, 0, 1, 0, 1])],
	['unexpected stream', Buffer.from([2, 0, 0, 0, 0, 0, 0, 0])]
])('rejects a Docker stream containing a %s', async (_label, bytes) => {
	const channel = Duplex.from([bytes]);

	const requests = hostRequests(channel);

	await expect(requests.next()).rejects.toThrow();
});

it('requires the service to acknowledge the protocol before opening', async () => {
	const channel = Duplex.from({
		readable: Duplex.from([frame('{"version":2}\n')]),
		writable: new PassThrough()
	});

	await expect(
		beginHostRequests(channel, new AbortController().signal)
	).rejects.toThrow('acknowledge');
});

it.each([
	'',
	'{}',
	'{"status":"OK"}\n{"status":"EIO"}',
	'{"status":"OK","identity":1}'
])('refuses an incomplete or ambiguous native reply', (stdout) => {
	expect(() => hostReply(stdout)).toThrow();
});
