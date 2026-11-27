const commonRoots = [
	'/bin',
	'/nix/store',
	'/nix/var/nix/profiles',
	'/sbin',
	'/usr/bin',
	'/usr/sbin',
	'/usr/lib',
	'/usr/libexec',
	'/usr/share',
	'/usr/include'
];

/**
Canonical host system roots for Linux and macOS. A host path outside the
checkout is a system file if it is at or below a root for its platform.
Other platforms have no listed roots.
*/
export const hostSystemRoots: Readonly<
	Record<'darwin' | 'linux', readonly string[]>
> = Object.freeze({
	darwin: Object.freeze([
		...commonRoots,
		'/private/etc',
		'/System/Applications',
		'/System/Cryptexes',
		'/System/Developer',
		'/System/DriverKit',
		'/System/KernelKit',
		'/System/Library',
		'/System/iOSSupport',
		'/System/x86Support',
		'/Library/Apple/System',
		'/Library/Developer/CommandLineTools',
		'/Applications/Xcode.app/Contents/Developer'
	]),
	linux: Object.freeze([
		...commonRoots,
		'/etc',
		'/lib',
		'/lib64',
		'/run/current-system',
		'/usr/lib64'
	])
});
