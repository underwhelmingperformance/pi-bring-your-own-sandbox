import { spawn } from 'node:child_process';
import { constants } from 'node:os';

import type { LaunchFrame, TargetInvocation } from './contracts.js';

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isInvocation(value: unknown): value is TargetInvocation {
	return (
		isRecord(value) &&
		typeof value.executable === 'string' &&
		Array.isArray(value.args) &&
		value.args.every((argument: unknown) => typeof argument === 'string') &&
		typeof value.cwd === 'string' &&
		isRecord(value.env) &&
		Object.values(value.env).every(
			(entry) => typeof entry === 'string' || entry === null
		)
	);
}

function launch(invocation: TargetInvocation): void {
	const environment = new Map<string, string>();

	for (const [key, value] of Object.entries(process.env)) {
		if (value !== undefined) {
			environment.set(key, value);
		}
	}

	environment.set('HOME', '/tmp');

	for (const [key, value] of Object.entries(invocation.env)) {
		if (value === null) {
			environment.delete(key);
			continue;
		}

		environment.set(key, value);
	}

	const child = spawn(invocation.executable, invocation.args, {
		cwd: invocation.cwd,
		env: Object.fromEntries(environment),
		uid: 65_534,
		gid: 65_534,
		stdio: ['ignore', 'pipe', 'pipe']
	});

	function emit(frame: LaunchFrame): void {
		if (process.stdout.write(JSON.stringify(frame) + '\n')) {
			return;
		}

		child.stdout.pause();
		child.stderr.pause();
	}

	process.stdout.on('drain', () => {
		child.stdout.resume();
		child.stderr.resume();
	});
	child.stdout.on('data', (data: Buffer) => {
		emit({ kind: 'stdout', data: data.toString('base64') });
	});
	child.stderr.on('data', (data: Buffer) => {
		emit({ kind: 'stderr', data: data.toString('base64') });
	});

	let failure: LaunchFrame | undefined;

	child.on('error', (error) => {
		const code: unknown = 'code' in error ? error.code : undefined;

		failure = {
			kind:
				code === 'ENOENT' || code === 'ENOTDIR'
					? 'not-found'
					: code === 'EACCES' || code === 'EPERM'
						? 'permission-denied'
						: 'start-failed'
		};
	});
	child.on('close', (code, signal) => {
		if (failure !== undefined) {
			emit(failure);

			return;
		}

		if (signal !== null) {
			emit({
				kind: 'exited',
				exit: {
					kind: 'signal',
					signal,
					signalNumber: constants.signals[signal]
				}
			});

			return;
		}

		if (code === null) {
			emit({ kind: 'start-failed' });

			return;
		}

		emit({ kind: 'exited', exit: { kind: 'code', code } });
	});
}

const input: unknown = JSON.parse(process.argv[1] ?? '{}');

if (!isInvocation(input)) {
	throw new TypeError(
		'The Docker launcher requires a valid target invocation.'
	);
}

launch(input);
