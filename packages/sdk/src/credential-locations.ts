import { homedir } from 'node:os';
import path from 'node:path';

import { getAgentDir } from '@earendil-works/pi-coding-agent';

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
	'~/.cargo/credentials.toml',
	'~/.cargo/credentials',
	'~/.npmrc',
	'~/.gem/credentials',
	'~/.yarnrc.yml',
	'~/.terraform.d/credentials.tfrc.json',
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

/**
Expands the home-relative exclusions and adds both credential files in Pi's
effective agent directory. Compare the absolute paths and their aliases when
enforcing the exclusions.
*/
export function resolveCredentialLocations(): readonly string[] {
	const home = homedir();
	const agentDirectory = getAgentDir();

	return Object.freeze([
		...credentialLocations.map((location) =>
			path.join(home, location.slice(2))
		),
		path.resolve(agentDirectory, 'auth.json'),
		path.resolve(agentDirectory, 'mcp-auth.json')
	]);
}

export function describeHostUserData(
	access: 'denied' | 'read-only' | 'read-write',
	isUnrestrictedHost: boolean
): string {
	return access === 'denied' || isUnrestrictedHost
		? access
		: access + ' (credential locations excluded)';
}
