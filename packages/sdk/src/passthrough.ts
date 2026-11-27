import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import type {
	SandboxBackend,
	SandboxOpenContext,
	ShellDialect
} from './contracts.js';
import { hostFiles } from './host-files.js';
import { HostOperations } from './host-operations.js';
import { PosixProcessRunner } from './host-process.js';
import { HostSearch } from './host-search.js';
import type { PathGrants, Profile } from './policy-model.js';
import { unrestrictedPolicy } from './policy-model.js';

async function executable(
	command: string,
	workspace: string,
	environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
	const directories = (environment['PATH'] ?? '').split(path.delimiter);

	for (const directory of directories) {
		const candidate = path.resolve(workspace, directory, command);

		try {
			await access(candidate, constants.X_OK);

			const entry = await stat(candidate);

			if (entry.isFile()) {
				return candidate;
			}
		} catch {
			continue;
		}
	}

	return undefined;
}

export const basePassthroughProfile: Profile = Object.freeze({
	policy: unrestrictedPolicy,
	capabilities: ['files.read', 'files.write', 'files.list'] as const,
	processKinds: ['argv'] as const,
	terminationScope: 'process-group',
	exitStatus: 'guaranteed',
	shells: []
});

export async function probePassthrough(workspace: string) {
	const environment = { ...process.env };
	const shells = new Map<ShellDialect, string>();

	for (const [dialect, command] of [
		['bash', 'bash'],
		['sh', 'sh'],
		['powershell', 'pwsh']
	] as const) {
		const filename = await executable(command, workspace, environment);

		if (filename !== undefined) {
			shells.set(dialect, filename);
		}
	}

	const [fd, fdfind, grep] = await Promise.all([
		executable('fd', workspace, environment),
		executable('fdfind', workspace, environment),
		executable('rg', workspace, environment)
	]);
	const find = fd ?? fdfind;
	const profile: Profile = {
		...basePassthroughProfile,
		processKinds: shells.size === 0 ? ['argv'] : ['argv', 'shell'],
		capabilities: [
			...basePassthroughProfile.capabilities,
			...(find === undefined ? [] : ['search.find' as const]),
			...(grep === undefined ? [] : ['search.grep' as const])
		],
		shells: shells.keys().toArray()
	};

	return { environment, profile, shells, find, grep };
}

type Inventory = Awaited<ReturnType<typeof probePassthrough>>;

export async function openPassthrough(
	workspace: string,
	context: SandboxOpenContext,
	inventory?: Inventory,
	paths?: PathGrants
): Promise<SandboxBackend> {
	const { environment, shells, profile, find, grep } =
		inventory ?? (await probePassthrough(workspace));
	const operations = new HostOperations();

	return operations.run('open', context, () => {
		const processes = new PosixProcessRunner(workspace, environment, shells, {
			providerId: 'passthrough'
		});
		const search = new HostSearch(
			workspace,
			{
				...(find !== undefined && { find }),
				...(grep !== undefined && { grep })
			},
			processes,
			operations
		).methods();
		const defaultShell = shells.keys().next().value;
		const home = homedir();
		const grantedPaths = (['read', 'write'] as const).flatMap((kind) =>
			(paths?.[kind] ?? []).map((hostPath) => ({
				kind,
				hostPath,
				targetPath: hostPath
			}))
		);

		return Promise.resolve({
			id: `passthrough:${context.operationId}`,
			workspace: {
				root: workspace,
				pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
				relationship: 'shared',
				home,
				hostUserDataRoot: home,
				...(defaultShell !== undefined && { defaultShell })
			},
			profile,
			...(grantedPaths.length > 0 && { grantedPaths }),
			policyDescription:
				'Processes use the host filesystem, network and inherited environment. No sandbox isolation is applied.',
			recovery: { kind: 'none' },
			exec: (request, execution) =>
				operations.run('exec', execution, (running) =>
					processes.run(request, { ...running, onOutput: execution.onOutput })
				),
			files: hostFiles(workspace, operations),
			...(search !== undefined && { search }),
			dispose: (disposal) => operations.dispose(disposal)
		} satisfies SandboxBackend);
	});
}
