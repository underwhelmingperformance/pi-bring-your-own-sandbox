declare const displayTextBrand: unique symbol;

export type DisplayText = string & { readonly [displayTextBrand]: true };

const maxDisplayLength = 4096;

function limitDisplayText(parts: Iterable<string>): DisplayText {
	let text = '';
	let previousLength = 0;

	for (const part of parts) {
		if (text.length + part.length > maxDisplayLength) {
			const prefix =
				text.length === maxDisplayLength ? text.slice(0, previousLength) : text;

			return `${prefix}…` as DisplayText;
		}

		previousLength = text.length;
		text += part;
	}

	return text as DisplayText;
}

function* escapeControls(text: string): Generator<string> {
	for (const character of text) {
		const code = character.codePointAt(0) ?? 0;

		yield code < 32 || (code >= 127 && code <= 159)
			? String.raw`\x${code.toString(16).padStart(2, '0')}`
			: character;
	}
}

/**
Escape terminal control characters and limit the length before display.
*/
export function cleanDisplayText(text: string): DisplayText {
	return limitDisplayText(escapeControls(text));
}

function* displayParts(lines: readonly DisplayText[]): Generator<string> {
	for (const [index, line] of lines.entries()) {
		if (index > 0) {
			yield '\n';
		}

		for (const [part] of line.matchAll(/\\x[\da-f]{2}|./gsu)) {
			yield part;
		}
	}
}

export function joinDisplayLines(lines: readonly DisplayText[]): DisplayText {
	return limitDisplayText(displayParts(lines));
}
