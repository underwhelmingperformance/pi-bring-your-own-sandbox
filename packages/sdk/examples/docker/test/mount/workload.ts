import {
	closeSync,
	existsSync,
	openSync,
	readFileSync,
	writeFileSync,
	writeSync
} from 'node:fs';
import { constants } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';

const file = '/workspace/source.txt';
const initial = readFileSync(file, 'utf8');

function isRefused(operation: () => unknown, errno: number) {
	try {
		operation();

		return false;
	} catch (error) {
		return error instanceof Error && 'errno' in error && error.errno === -errno;
	}
}

async function isStaleWriteRefused() {
	const fd = openSync(file, 'w+');

	try {
		writeSync(fd, 'workload edit');

		for (let attempt = 0; attempt < 500; attempt++) {
			if (readFileSync(file, 'utf8') === 'host replacement') {
				return isRefused(
					() => writeSync(fd, 'unexpected', 0),
					constants.errno.ESTALE
				);
			}

			await delay(10);
		}

		throw new Error('The host did not replace the file.');
	} finally {
		closeSync(fd);
	}
}

const isDenied =
	process.argv[1] === 'read-write'
		? await isStaleWriteRefused()
		: isRefused(() => {
				writeFileSync(file, 'unexpected');
			}, constants.errno.EROFS);
const status = new Map<string, string>();

for (const line of readFileSync('/proc/self/status', 'utf8').split('\n')) {
	const [field, value] = line.split(':', 2);

	if (field && value !== undefined) {
		status.set(field, value.trim());
	}
}

const privileges = Object.fromEntries(
	['CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb', 'NoNewPrivs'].map(
		(key) => [key, status.get(key)]
	)
);

process.stdout.write(
	JSON.stringify({
		initial,
		denied: isDenied,
		file: readFileSync(file, 'utf8'),
		backing: existsSync('/backing/source.txt'),
		alias: existsSync('/workspace/alias'),
		ids: ['Uid', 'Gid'].map((key) => status.get(key)?.split(/\s+/).map(Number)),
		groups: status.get('Groups'),
		device: existsSync('/dev/fuse'),
		socket: existsSync('/control/service'),
		privileges
	})
);
