import { InvalidSandboxConfigError } from './errors.js';
import { openPassthrough } from './passthrough.js';
import type { ProviderServiceV1 } from './protocol.js';
import { isRecord } from './validation.js';

export const passthroughProvider: ProviderServiceV1 =
	Object.freeze<ProviderServiceV1>({
		id: 'passthrough',
		label: 'Host execution without isolation',
		defaultPolicy: Object.freeze({
			workspaceAccess: 'read-write',
			filesystemScope: 'provider-default',
			networkAccess: 'provider-default'
		}),
		capabilities: {
			processKinds: ['argv', 'shell'],
			terminationScope: 'process-group',
			exitStatus: 'guaranteed',
			operations: [
				'exec',
				'files.read',
				'files.write',
				'files.list',
				'search.find',
				'search.grep'
			],
			shells: ['bash', 'sh', 'powershell']
		},
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		configure(input: unknown) {
			if (!isRecord(input) || Object.keys(input).length > 0) {
				throw new InvalidSandboxConfigError({
					operation: 'configure',
					providerId: 'passthrough'
				});
			}

			return {
				open: (request, context) =>
					openPassthrough(request.hostWorkspace, context)
			};
		}
	});
