import type { BashOperations } from '@earendil-works/pi-coding-agent';

import type { ProcessExit } from './contracts.js';

export function piProcessResult(
	exit: ProcessExit
): Awaited<ReturnType<BashOperations['exec']>> {
	switch (exit.kind) {
		case 'code': {
			return { exitCode: exit.code };
		}

		case 'signal': {
			return { exitCode: 128 + exit.signalNumber };
		}

		case 'unavailable': {
			// eslint-disable-next-line unicorn/no-null -- Pi requires null when a completed command has no exit status.
			return { exitCode: null };
		}
	}
}
