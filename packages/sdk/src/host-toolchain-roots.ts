const commonRoots = [
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

/**
Default read roots for host toolchains on Linux and macOS. Providers expand
the home-relative entries and apply credential exclusions inside every root.
*/
export const hostToolchainRoots: Readonly<
	Record<'darwin' | 'linux', readonly string[]>
> = Object.freeze({
	darwin: Object.freeze([...commonRoots, '~/Library/pnpm']),
	linux: Object.freeze([...commonRoots, '~/.local/share/pnpm'])
});
