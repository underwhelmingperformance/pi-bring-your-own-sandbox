import { escapeShellOutput } from './display-text.js';

export class PiShellOutput {
	readonly #decoder = new TextDecoder('utf-8', { ignoreBOM: true });
	readonly #onData: (data: Buffer) => void;

	constructor(onData: (data: Buffer) => void) {
		this.#onData = onData;
	}

	#emit(text: string): void {
		if (text !== '') {
			this.#onData(Buffer.from(escapeShellOutput(text)));
		}
	}

	write(data: Uint8Array): void {
		this.#emit(this.#decoder.decode(data, { stream: true }));
	}

	flush(): void {
		this.#emit(this.#decoder.decode());
	}
}
