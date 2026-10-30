import type {
	BackendFiles,
	RecoveryDescriptor,
	SandboxBackend
} from './contracts.js';
import { snapshotCapabilities } from './validation.js';

export function snapshotRecovery(
	recovery: RecoveryDescriptor
): RecoveryDescriptor {
	return recovery.kind === 'none'
		? Object.freeze({ kind: 'none' })
		: Object.freeze({
				kind: 'allocation',
				id: recovery.id,
				instructions: recovery.instructions,
				lease: recovery.lease,
				...(recovery.expiresAt !== undefined && {
					expiresAt: recovery.expiresAt
				})
			});
}

export function snapshotBackend(backend: SandboxBackend): SandboxBackend {
	const read = backend.files?.read;
	const write = backend.files?.write;
	const list = backend.files?.list;
	const files: BackendFiles = Object.freeze({
		...(read !== undefined && {
			read: Object.freeze({
				readFile: read.readFile.bind(read),
				access: read.access.bind(read),
				stat: read.stat.bind(read)
			})
		}),
		...(write !== undefined && {
			write: Object.freeze({
				writeFile: write.writeFile.bind(write),
				access: write.access.bind(write),
				mkdir: write.mkdir.bind(write)
			})
		}),
		...(list !== undefined && {
			list: Object.freeze({
				listDirectory: list.listDirectory.bind(list),
				stat: list.stat.bind(list)
			})
		})
	});
	const search = backend.search;
	const workspace = backend.workspace;
	return Object.freeze({
		id: backend.id,
		workspace: Object.freeze({
			root: workspace.root,
			pathFlavor: workspace.pathFlavor,
			relationship: workspace.relationship,
			description: workspace.description,
			...(workspace.home !== undefined && { home: workspace.home }),
			...(workspace.defaultShell !== undefined && {
				defaultShell: workspace.defaultShell
			})
		}),
		capabilities: snapshotCapabilities(backend.capabilities),
		policy: Object.freeze({
			workspaceAccess: backend.policy.workspaceAccess,
			filesystemScope: backend.policy.filesystemScope,
			networkAccess: backend.policy.networkAccess
		}),
		policyDescription: backend.policyDescription,
		recovery: snapshotRecovery(backend.recovery),
		exec: backend.exec.bind(backend),
		dispose: backend.dispose.bind(backend),
		...(backend.files !== undefined && { files }),
		...(search !== undefined && {
			search: Object.freeze({
				...(search.find !== undefined && { find: search.find.bind(search) }),
				...(search.grep !== undefined && { grep: search.grep.bind(search) })
			})
		})
	});
}
