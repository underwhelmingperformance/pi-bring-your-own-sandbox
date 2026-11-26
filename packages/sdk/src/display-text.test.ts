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
