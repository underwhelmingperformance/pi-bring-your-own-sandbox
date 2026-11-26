/**
Home-relative paths that readable provider profiles must exclude from host
user data. Each entry applies to the path and its descendants outside the
checkout.
*/
export const credentialLocations: readonly string[] = Object.freeze([
	'~/.ssh',
	'~/.aws',
	'~/.gnupg',
	'~/.netrc',
	'~/.git-credentials',
	'~/.config/gh',
	'~/.docker/config.json',
	'~/.kube',
	'~/.config/gcloud',
	'~/.azure',
	'~/.pypirc',
	'~/.password-store',
	'~/Library/Keychains',
	'~/.local/share/keyrings',
	'~/Library/Application Support/Google/Chrome',
	'~/Library/Application Support/Firefox',
	'~/Library/Safari',
	'~/Library/Cookies',
	'~/.mozilla',
	'~/.config/google-chrome',
	'~/.config/chromium'
]);

export function describeHostUserData(
	access: 'denied' | 'read-only' | 'read-write',
	isUnrestrictedHost: boolean
): string {
	return access === 'denied' || isUnrestrictedHost
		? access
		: access + ' (credential locations excluded)';
}
