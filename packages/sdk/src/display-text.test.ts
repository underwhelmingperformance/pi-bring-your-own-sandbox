import { expect, it } from 'vitest';

import { cleanDisplayText, joinDisplayLines } from './display-text.js';

it('replaces every C0, DEL and C1 character with a visible escape', () => {
	const codes = Array.from({ length: 160 }, (_, code) => code).filter(
		(code) => code < 32 || code >= 127
	);

	expect(cleanDisplayText(String.fromCodePoint(...codes))).toStrictEqual(
		codes
			.map((code) => String.raw`\x${code.toString(16).padStart(2, '0')}`)
			.join('')
	);
});

it('escapes bidirectional embeddings, overrides, isolates and invisible separators', () => {
	const codes = [
		0x20_0b, 0x20_28, 0x20_29, 0x20_2a, 0x20_2b, 0x20_2c, 0x20_2d, 0x20_2e,
		0x20_66, 0x20_67, 0x20_68, 0x20_69, 0xfe_ff
	];

	expect(cleanDisplayText(String.fromCodePoint(...codes))).toStrictEqual(
		codes.map((code) => String.raw`\u{${code.toString(16)}}`).join('')
	);
});

it.each([
	{ label: 'emoji with a zero-width joiner', value: '👩\u{200D}💻' },
	{ label: 'text with a zero-width non-joiner', value: 'می\u{200C}روم' },
	{ label: 'right-to-left mark', value: '\u{200F}שלום' },
	{ label: 'left-to-right mark', value: '\u{200E}Hello' },
	{ label: 'Arabic letter mark', value: '\u{061C}مرحبا' }
])('preserves $label', ({ value }) => {
	expect(cleanDisplayText(value)).toStrictEqual(value);
});

it.each([
	{ suffix: '', remaining: 0, expected: '' },
	{ suffix: 'x', remaining: 0, expected: '…' },
	{ suffix: '😀', remaining: 1, expected: '…' },
	{ suffix: '\u{0}', remaining: 3, expected: '…' },
	{ suffix: '\u{0}x', remaining: 4, expected: '…' }
])(
	'bounds cleaned text with $remaining code units left and suffix $suffix',
	({ suffix, remaining, expected }) => {
		const prefix = 'a'.repeat(4096 - remaining);
		const preserved =
			remaining === 0 && suffix !== '' ? prefix.slice(1) : prefix;

		expect(cleanDisplayText(prefix + suffix)).toStrictEqual(
			preserved + expected
		);
	}
);

it('preserves only the line breaks added by the formatter and bounds the joined text', () => {
	const first = cleanDisplayText('a\nb\t' + 'x'.repeat(4085));
	const second = cleanDisplayText('c');

	expect(joinDisplayLines([first, second])).toStrictEqual(first + '…');
	expect(joinDisplayLines([cleanDisplayText('a\nb'), second])).toStrictEqual(
		'a\\x0ab\nc'
	);
});

it.each([0x20_2e, 0xfe_ff])(
	'keeps the escape for %s intact when truncating joined text',
	(code) => {
		const prefix = 'a'.repeat(4087);
		const lines = [
			cleanDisplayText(prefix),
			cleanDisplayText(String.fromCodePoint(code) + 'z')
		];

		expect(joinDisplayLines(lines)).toStrictEqual(prefix + '\n…');
	}
);
