import { expect, it } from 'vitest';

import { isProtectedWorkspacePath } from './protected-workspace-paths.js';

it.each([
	['.git/config', false, true],
	['.git/hooks/pre-commit', false, true],
	['.git/hooks/../hooks/pre-commit', false, true],
	['.git/config.local', false, false],
	['.git', false, false],
	['.git', true, true],
	['.', true, true],
	['.bashrc', false, true],
	['.aws/config', false, true],
	['.mcp.json', false, true]
] as const)(
	'checks %s with parent matching %s',
	(filename, includesParents, expected) => {
		expect(isProtectedWorkspacePath(filename, { includesParents })).toBe(
			expected
		);
	}
);

it('checks an alternate list with Windows path separators', () => {
	const matches = ['Config\\Hooks\\script.ps1', '.envrc'].map((filename) =>
		isProtectedWorkspacePath(filename, {
			pathFlavor: 'win32',
			paths: ['config/hooks']
		})
	);

	expect(matches).toStrictEqual([true, false]);
});
