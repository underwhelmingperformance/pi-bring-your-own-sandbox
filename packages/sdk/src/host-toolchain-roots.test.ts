import { expect, it } from 'vitest';

import { hostToolchainRoots } from './host-toolchain-roots.js';

it('defines the default toolchain roots for Linux and macOS', () => {
	const common = [
		'~/.cargo',
		'~/.rustup',
		'~/.local/share/mise',
		'~/.nvm',
		'~/.local/bin',
		'~/.bun',
		'~/.deno',
		'~/.pyenv',
		'~/.volta',
		'/opt/homebrew',
		'/usr/local',
		'/opt/local'
	];

	expect(hostToolchainRoots).toStrictEqual({
		darwin: [...common, '~/Library/pnpm'],
		linux: [...common, '~/.local/share/pnpm']
	});
	expect([
		Object.isFrozen(hostToolchainRoots),
		Object.isFrozen(hostToolchainRoots.darwin),
		Object.isFrozen(hostToolchainRoots.linux)
	]).toStrictEqual([true, true, true]);
});
