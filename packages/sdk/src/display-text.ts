declare const displayTextBrand: unique symbol;

export type DisplayText = string & { readonly [displayTextBrand]: true };

const maxDisplayLength = 4096;
const unsafeShellOutputCharacter =
	/[\u{7F}-\u{9F}\u{200B}\u{2028}-\u{202E}\u{2066}-\u{2069}\u{FEFF}]/u;
const unsafeShellOutputCharacters = new RegExp(
	unsafeShellOutputCharacter.source,
	'gu'
);

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

		if (code >= 32 && !unsafeShellOutputCharacter.test(character)) {
			yield character;
			continue;
		}

		yield escapeCodePoint(code);
	}
}

function escapeCodePoint(code: number): string {
	const hex = code.toString(16);

	return code <= 255
		? String.raw`\x${hex.padStart(2, '0')}`
		: String.raw`\u{${hex}}`;
}

export function escapeShellOutput(text: string): string {
	return text.replaceAll(unsafeShellOutputCharacters, (character) =>
		escapeCodePoint(character.codePointAt(0) ?? 0)
	);
}

/**
Escape display-unsafe characters and limit the length before display.
*/
export function cleanDisplayText(text: string): DisplayText {
	return limitDisplayText(escapeControls(text));
}

export function cleanFullDisplayText(text: string): DisplayText {
	return [...escapeControls(text)].join('') as DisplayText;
}

function* displayParts(lines: readonly DisplayText[]): Generator<string> {
	for (const [index, line] of lines.entries()) {
		if (index > 0) {
			yield '\n';
		}

		for (const [part] of line.matchAll(
			/\\(?:x[\da-f]{2}|u\{[\da-f]{1,6}\})|./gsu
		)) {
			yield part;
		}
	}
}

export function joinDisplayLines(lines: readonly DisplayText[]): DisplayText {
	return limitDisplayText(displayParts(lines));
}
