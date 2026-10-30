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

async function executable(
	command: string,
	workspace: string,
	environment: NodeJS.ProcessEnv
): Promise<string | undefined> {
	const directories = (environment.PATH ?? '').split(path.delimiter);
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

export async function openPassthrough(
	workspace: string,
	context: SandboxOpenContext
): Promise<SandboxBackend> {
	const operations = new HostOperations();
	const environment = { ...process.env };
	return operations.run('open', context, async () => {
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
		const processes = new PosixProcessRunner(workspace, environment, shells);
		const defaultShell = shells.keys().next().value;
		return {
			id: `passthrough:${context.operationId}`,
			workspace: {
				root: workspace,
				pathFlavor: process.platform === 'win32' ? 'win32' : 'posix',
				relationship: 'shared',
				home: homedir(),
				description:
					'The host workspace is shared. No sandbox isolation is applied.',
				...(defaultShell !== undefined && { defaultShell })
			},
			capabilities: {
				operations: ['exec', 'files.read', 'files.write', 'files.list'],
				shells: shells.keys().toArray()
			},
			policy: {
				workspaceAccess: 'read-write',
				filesystemScope: 'provider-default',
				networkAccess: 'provider-default'
			},
			policyDescription:
				'Processes use the host filesystem, network and inherited environment. No sandbox isolation is applied.',
			recovery: { kind: 'none' },
			exec: (request, execution) =>
				operations.run('exec', execution, (running) =>
					processes.run(request, { ...running, onOutput: execution.onOutput })
				),
			files: hostFiles(workspace, operations),
			dispose: (disposal) => operations.dispose(disposal)
		};
	});
}
