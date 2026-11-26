import { Type } from 'typebox';

import type {
	BackendProcessOutcome,
	ProcessExit,
	ProcessOutput,
	SandboxErrorContext,
	SandboxErrorInfo
} from './contracts.js';
import { SandboxOperationError, SandboxTransportError } from './errors.js';
import { mapSandboxErrno } from './host-error.js';
import { checker } from './schemas.js';

const nonNegativeIntegerSchema = Type.Integer({
	minimum: 0,
	maximum: Number.MAX_SAFE_INTEGER
});
const signalNumberSchema = Type.Integer({
	minimum: 1,
	maximum: Number.MAX_SAFE_INTEGER
});
const exitSchema = Type.Union([
	Type.Object({ kind: Type.Literal('code'), code: nonNegativeIntegerSchema }),
	Type.Object({
		kind: Type.Literal('signal'),
		signal: Type.String({ minLength: 1 }),
		signalNumber: signalNumberSchema
	})
]);
const outputSchema = Type.Object({
	kind: Type.Enum(['stdout', 'stderr']),
	data: Type.Refine(
		Type.String(),
		(value) => Buffer.from(value, 'base64').toString('base64') === value
	)
});

const launchFrameSchema = Type.Union([
	outputSchema,
	Type.Object({ kind: Type.Literal('exited'), exit: exitSchema }),
	Type.Object({
		kind: Type.Enum(['not-found', 'permission-denied', 'start-failed'])
	})
]);

const isLaunchFrame = checker(launchFrameSchema);

/**
Decodes bounded launcher frames and forwards only child output to SDK consumers.
*/
export class SandboxLaunchFrames {
	readonly #onOutput: (output: ProcessOutput) => void;
	readonly #identity: SandboxErrorContext;
	readonly #decoder = new TextDecoder('utf-8', { fatal: true });
	#pending = '';
	#exit: ProcessExit | undefined;
	#failure: SandboxErrorInfo | undefined;
	#hasFinal = false;

	constructor(
		onOutput: (output: ProcessOutput) => void,
		identity: SandboxErrorContext
	) {
		this.#onOutput = onOutput;
		this.#identity = { ...identity };
	}

	#invalid(): never {
		throw new SandboxTransportError(this.#identity, {
			cause: new TypeError(
				'The target returned an invalid or incomplete launcher frame.'
			)
		});
	}

	#frame(value: unknown): void {
		if (this.#hasFinal || !isLaunchFrame(value)) {
			this.#invalid();
		}

		if (value.kind === 'stdout' || value.kind === 'stderr') {
			const bytes = Buffer.from(value.data, 'base64');

			this.#onOutput({ stream: value.kind, data: bytes });

			return;
		}

		this.#hasFinal = true;

		switch (value.kind) {
			case 'exited': {
				this.#exit = value.exit;

				return;
			}

			case 'not-found': {
				this.#failure = mapSandboxErrno('ENOENT', this.#identity);

				return;
			}

			case 'permission-denied': {
				this.#failure = mapSandboxErrno('EACCES', this.#identity);

				return;
			}

			case 'start-failed': {
				this.#failure = new SandboxOperationError(this.#identity);

				return;
			}

			default: {
				this.#invalid();
			}
		}
	}

	/**
	Accepts ordered carrier output. Carrier stderr indicates a transport failure.
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
	Read the child result after the carrier finishes.
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
