import path from 'node:path';

/**
Checkout-relative paths that can configure host tools or run code on the host.
*/
export const defaultProtectedWorkspacePaths: readonly string[] = Object.freeze([
	'.git/hooks',
	'.git/config',
	'.bashrc',
	'.bash_profile',
	'.bash_login',
	'.profile',
	'.zshrc',
	'.zshenv',
	'.zprofile',
	'.zlogin',
	'.zlogout',
	'.config/fish',
	'.envrc',
	'.direnv',
	'.vscode',
	'.idea',
	'.devcontainer',
	'.aws',
	'.mcp.json',
	'.pi'
]);

/**
Checks whether a checkout-relative path is within a protected path. For
renames and recursive removal, enable parent matching and check both rename
endpoints. Use the target path flavour. Resolve links and protect the
underlying resources separately.
*/
export function isProtectedWorkspacePath(
	filename: string,
	options: {
		readonly paths?: readonly string[];
		readonly pathFlavor?: 'posix' | 'win32';
		readonly includesParents?: boolean;
	} = {}
): boolean {
	const flavor = path[options.pathFlavor ?? 'posix'];
	const clean = (value: string) => flavor.resolve(flavor.sep, value);
	const target = clean(filename);

	function isWithin(parent: string, entry: string): boolean {
		const relative = flavor.relative(parent, entry);

		return (
			relative !== '..' &&
			!relative.startsWith('..' + flavor.sep) &&
			!flavor.isAbsolute(relative)
		);
	}

	return (options.paths ?? defaultProtectedWorkspacePaths).some((entry) => {
		const protectedPath = clean(entry);

		return (
			isWithin(protectedPath, target) ||
			(options.includesParents === true && isWithin(target, protectedPath))
		);
	});
}
