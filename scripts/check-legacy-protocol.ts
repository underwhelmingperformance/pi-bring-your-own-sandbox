import { spawnSync } from 'node:child_process';

const root = new URL('../', import.meta.url);
const fields =
	'(^|[^[:alnum:]_])(configurationVersion|discoveryVersion|guardVersion|protocolVersion|serviceVersions)([^[:alnum:]_]|$)';
const channels =
	'pi-byos:discovery:|pi-byos:[[:alnum:]:-]*:v[12]([^[:alnum:]]|$)';
const kinds = 'pi-byos\\.(discover|service)([^[:alnum:]]|$)';
const pattern = [fields, channels, kinds].join('|');
const result = spawnSync(
	'git',
	[
		'grep',
		'--untracked',
		'--line-number',
		'-I',
		'-E',
		pattern,
		'--',
		'.',
		':(exclude)scripts/check-legacy-protocol.ts',
		':(exclude)packages/sdk/src/fixtures/marker-mcp-server.ts'
	],
	{ cwd: root, stdio: 'inherit' }
);

if (result.status !== 1) {
	process.exitCode = 1;
	process.stderr.write(
		result.status === 0
			? 'The repository still contains a legacy BYOS protocol field or channel.\n'
			: 'Git could not scan the repository for legacy BYOS protocol fields and channels.\n'
	);
}
