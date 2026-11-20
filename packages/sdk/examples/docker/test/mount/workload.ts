import {
	closeSync,
	existsSync,
	fstatSync,
	ftruncateSync,
	openSync,
	readdirSync,
	readFileSync,
	unlinkSync,
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

function checkCreates() {
	for (let index = 1; index < 16; index++) {
		closeSync(openSync('/workspace/create-' + String(index), 'wx'));
	}

	return {
		unlink: isRefused(() => {
			unlinkSync('/workspace/concurrent.txt');
		}, constants.errno.ENOTSUP),
		limit: isRefused(() => {
			closeSync(openSync('/workspace/create-16', 'wx'));
		}, constants.errno.EDQUOT),
		reserved: isRefused(() => {
			closeSync(openSync('/workspace/.reserved', 'wx'));
		}, constants.errno.EACCES)
	};
}

async function writeAndInspect() {
	const resize = openSync('/workspace/truncate.txt', 'w+');
	let isOversizedDenied: boolean;

	try {
		writeSync(resize, 'abcdef');
		ftruncateSync(resize, 2);
		ftruncateSync(resize, 4);
		isOversizedDenied = isRefused(() => {
			ftruncateSync(resize, 16 * 1024 * 1024 + 1);
		}, constants.errno.EFBIG);
	} finally {
		closeSync(resize);
	}

	const reader = openSync(file, 'r');
	const save = '/workspace/editor-save';
	const editor = openSync(save, 'wx+');
	const fd = openSync(file, 'w+');

	try {
		writeSync(editor, 'workload replacement');

		const truncated = fstatSync(fd).size;

		writeSync(fd, 'workload edit');

		const written = fstatSync(fd).size;
		const readerSize = fstatSync(reader).size;
		const deadline = performance.now() + 45_000;

		while (performance.now() < deadline) {
			if (existsSync('/workspace/host-ready')) {
				writeFileSync('/workspace/concurrent.txt', 'workload replacement');

				const isRenamedDenied = isRefused(
					() => writeSync(editor, '!'),
					constants.errno.ESTALE
				);
				const isDenied = isRefused(
					() => writeSync(fd, 'unexpected', 0),
					constants.errno.ESTALE
				);

				return {
					denied: isDenied,
					renamedDenied: isRenamedDenied,
					oversizedDenied: isOversizedDenied,
					createChecks: checkCreates(),
					sizes: { truncated, written, readerSize }
				};
			}

			await delay(10);
		}

		throw new Error('The host did not replace the file.');
	} finally {
		closeSync(editor);
		closeSync(fd);
		closeSync(reader);
	}
}

const result =
	process.argv[1] === 'read-write'
		? await writeAndInspect()
		: {
				createDenied: isRefused(() => {
					closeSync(openSync('/workspace/editor-save', 'wx'));
				}, constants.errno.EROFS),
				denied: isRefused(() => {
					writeFileSync(file, 'unexpected');
				}, constants.errno.EROFS)
			};
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

const entries = readdirSync('/workspace');

process.stdout.write(
	JSON.stringify({
		initial,
		listedSource: entries.includes('source.txt'),
		listedStage: entries.includes('.pi-byos-write-fixture'),
		...result,
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
