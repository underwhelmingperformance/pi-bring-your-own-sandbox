import type {
	BackendProcessContext,
	ProcessRequest,
	SandboxBackend
} from '../contracts.js';

import { MemoryBackend } from './memory-backend.js';
import { fixtureProfile } from './profile-fixture.js';

export function shellBackend(output = 'target output') {
	const template = new MemoryBackend('exec');
	const requests: ProcessRequest[] = [];
	const backend: SandboxBackend = {
		id: template.id,
		workspace: template.workspace,

		policyDescription: template.policyDescription,
		recovery: template.recovery,
		profile: fixtureProfile(template.policy, {
			processKinds: ['argv', 'shell'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			operations: ['exec'],
			shells: ['bash', 'powershell']
		}),
		exec(request: ProcessRequest, context: BackendProcessContext) {
			requests.push(request);
			context.onOutput({
				stream: 'stdout',
				data: new TextEncoder().encode(output)
			});

			return Promise.resolve({
				kind: 'exited',
				exit: { kind: 'code', code: 0 }
			});
		},
		dispose: () => Promise.resolve()
	};

	return { backend, requests };
}
