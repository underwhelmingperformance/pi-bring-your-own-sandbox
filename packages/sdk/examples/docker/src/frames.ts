import type {
	BackendProcessOutcome,
	ProcessExit,
	ProcessOutput,
	RecoveryDescriptor,
	SandboxErrorInfo
} from 'pi-bring-your-own-sandbox/api';
import {
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';
import { Compile } from 'typebox/compile';

import { launchFrameSchema } from './schemas.js';

const frameValidator = Compile(launchFrameSchema);

/**
Decodes bounded launcher frames and forwards only child output to SDK consumers.
*/
export class LaunchFrames {
	readonly #onOutput: (output: ProcessOutput) => void;
	readonly #recovery: RecoveryDescriptor;
	readonly #decoder = new TextDecoder('utf-8', { fatal: true });
	#pending = '';
	#exit: ProcessExit | undefined;
	#failure: SandboxErrorInfo | undefined;
	#hasFinal = false;

	constructor(
		onOutput: (output: ProcessOutput) => void,
		recovery: RecoveryDescriptor
	) {
		this.#onOutput = onOutput;
		this.#recovery = recovery;
	}

	#invalid(): never {
		throw new SandboxTransportError(
			{
				operation: 'exec',
				providerId: 'example.docker',
				recovery: this.#recovery
			},
			{
				cause: new TypeError(
					'Docker returned an invalid or incomplete launcher frame.'
				)
			}
		);
	}

	#frame(value: unknown): void {
		if (this.#hasFinal || !frameValidator.Check(value)) {
			this.#invalid();
		}

		if (value.kind === 'stdout' || value.kind === 'stderr') {
			const bytes = Buffer.from(value.data, 'base64');

			this.#onOutput({ stream: value.kind, data: bytes });

			return;
		}

		const identity = {
			operation: 'exec',
			providerId: 'example.docker',
			recovery: this.#recovery
		} as const;

		this.#hasFinal = true;

		switch (value.kind) {
			case 'exited': {
				this.#exit = value.exit;

				return;
			}

			case 'not-found': {
				this.#failure = new SandboxPathNotFoundError(identity);

				return;
			}

			case 'permission-denied': {
				this.#failure = new SandboxPermissionDeniedError(identity);

				return;
			}

			case 'start-failed': {
				this.#failure = new SandboxOperationError(identity);

				return;
			}

			default: {
				this.#invalid();
			}
		}
	}

	/**
	Accepts ordered CLI chunks; launcher diagnostics are transport failures.
	*/
	accept(output: ProcessOutput): void {
		if (output.stream !== 'stdout') {
			this.#invalid();
		}

		this.#pending += this.#decoder.decode(output.data, { stream: true });

		for (;;) {
			const newline = this.#pending.indexOf('\n');

			if (newline === -1) {
				break;
			}

			if (newline > 262_144) {
				this.#invalid();
			}

			const line = this.#pending.slice(0, newline);

			this.#pending = this.#pending.slice(newline + 1);

			let frame: unknown;

			try {
				frame = JSON.parse(line);
			} catch {
				this.#invalid();
			}

			this.#frame(frame);
		}

		if (this.#pending.length > 262_144) {
			this.#invalid();
		}
	}

	/**
	Read the final child result after Docker confirms removal of the job container.
	*/
	finish(): BackendProcessOutcome {
		this.#pending += this.#decoder.decode();

		if (this.#pending.length > 0 || !this.#hasFinal) {
			this.#invalid();
		}

		if (this.#failure !== undefined) {
			throw this.#failure;
		}

		if (this.#exit === undefined) {
			this.#invalid();
		}

		return { kind: 'exited', exit: this.#exit };
	}
}
