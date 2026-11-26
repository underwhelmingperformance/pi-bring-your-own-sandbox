import type { GrepRequest } from './contracts.js';

/**
Builds the ripgrep arguments for a search inside the target. Extra options use
trusted SDK values and go before the pattern and path.
*/
export function sandboxRipgrepArguments(
	request: GrepRequest,
	target: string,
	extra: readonly string[] = []
): string[] {
	return [
		'--no-config',
		'--json',
		'--line-number',
		'--color=never',
		'--hidden',
		...extra,
		...(request.ignoreCase === true ? ['--ignore-case'] : []),
		...(request.literal === true ? ['--fixed-strings'] : []),
		...(request.glob === undefined ? [] : ['--glob', request.glob]),
		'--',
		request.pattern,
		target
	];
}
