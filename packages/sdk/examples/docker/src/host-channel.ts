import { request } from 'node:http';
import type { Duplex } from 'node:stream';

export async function attachHostChannel(
	socketPath: string,
	container: string,
	apiVersion: string,
	signal: AbortSignal
): Promise<Duplex> {
	if (!/^1\.\d+$/u.test(apiVersion)) {
		throw new TypeError('Docker returned an invalid Engine API version.');
	}

	return new Promise((resolve, reject) => {
		const attach = request({
			socketPath,
			path:
				'/v' +
				apiVersion +
				'/containers/' +
				encodeURIComponent(container) +
				'/attach?stream=1&stdin=1&stdout=1',
			method: 'POST',
			headers: { Connection: 'Upgrade', Upgrade: 'tcp' },
			agent: false
		});
		const abort = () =>
			attach.destroy(
				new Error('Opening the Docker workspace connection was cancelled.')
			);
		const detach = () => {
			signal.removeEventListener('abort', abort);
		};

		signal.addEventListener('abort', abort, { once: true });
		attach.once('error', (error) => {
			detach();
			reject(
				signal.aborted && signal.reason instanceof Error ? signal.reason : error
			);
		});

		if (signal.aborted) {
			abort();

			return;
		}

		attach.once('response', (response) => {
			detach();
			response.destroy();
			reject(
				new Error(
					'Docker refused to attach to the workspace service (HTTP ' +
						String(response.statusCode) +
						').'
				)
			);
		});
		attach.once('upgrade', (response, socket, head) => {
			detach();

			if (
				response.statusCode !== 101 ||
				response.headers.upgrade?.toLowerCase() !== 'tcp'
			) {
				socket.destroy();
				reject(new Error('Docker did not upgrade the workspace connection.'));

				return;
			}

			if (head.length > 0) {
				socket.unshift(head);
			}

			resolve(socket);
		});
		attach.end();
	});
}

function completeFrame(bytes: Buffer, limit: number) {
	if (bytes.length < 8) {
		return;
	}

	const size = bytes.readUInt32BE(4);

	if (bytes.readUInt32BE() !== 0x01_00_00_00 || size > limit) {
		throw new Error('Docker sent an invalid workspace stream frame.');
	}

	return bytes.length >= 8 + size ? size : undefined;
}

export async function* hostRequests(channel: Duplex) {
	const maxRequestBytes = 64 * 1024;
	let pending = Buffer.alloc(0);
	let line = Buffer.alloc(0);

	for await (const chunk of channel) {
		if (!Buffer.isBuffer(chunk)) {
			throw new TypeError('Expected bytes from the Docker workspace service.');
		}

		pending = Buffer.concat([pending, chunk]);

		for (
			let size = completeFrame(pending, maxRequestBytes - line.length);
			size !== undefined;
			size = completeFrame(pending, maxRequestBytes - line.length)
		) {
			line = Buffer.concat([line, pending.subarray(8, 8 + size)]);
			pending = pending.subarray(8 + size);

			const newline = line.indexOf(10);

			if (newline === -1) {
				continue;
			}

			if (newline !== line.length - 1) {
				throw new Error(
					'The Docker workspace service sent overlapping requests.'
				);
			}

			yield line.subarray(0, newline).toString('utf8');
			line = Buffer.alloc(0);
		}
	}

	if (line.length > 0 || pending.length > 0) {
		throw new Error('Docker closed the workspace channel during a request.');
	}
}

export async function beginHostRequests(channel: Duplex, signal: AbortSignal) {
	const requests = hostRequests(channel);
	const abort = () => {
		channel.destroy();
	};

	signal.addEventListener('abort', abort, { once: true });

	try {
		signal.throwIfAborted();

		const hello = requests.next();

		channel.write('{"version":1}\n');

		const message = await hello;

		if (message.done || message.value !== '{"version":1}') {
			throw new Error('Docker did not acknowledge the workspace protocol.');
		}

		return requests;
	} catch (error) {
		channel.destroy();
		signal.throwIfAborted();

		throw error;
	} finally {
		signal.removeEventListener('abort', abort);
	}
}

export function hostReply(stdout: string): string {
	const result: unknown = JSON.parse(stdout);

	if (
		typeof result !== 'object' ||
		result === null ||
		!('status' in result) ||
		typeof result.status !== 'string' ||
		!/^[A-Z][A-Z_0-9]{0,63}$/u.test(result.status) ||
		('identity' in result &&
			(typeof result.identity !== 'string' ||
				!/^[0-9]+\/[0-9]+\/-?[0-9]+$/u.test(result.identity)))
	) {
		throw new Error(
			'The native workspace operation returned an invalid reply.'
		);
	}

	return (
		JSON.stringify({
			status: result.status,
			...('identity' in result && { identity: result.identity })
		}) + '\n'
	);
}
