import type {
	SandboxBackend,
	SandboxErrorInfo,
	SandboxOperation
} from '../contracts.js';
import { StaleSandboxHandleError } from '../errors.js';
import type { SandboxOwner } from '../facade.js';
import { OperationRegistry } from '../lifecycle.js';
import { MutationQueue } from '../mutation-queue.js';

export class TestBackendOwner implements SandboxOwner {
	#isLive = true;
	readonly backend: SandboxBackend;
	readonly identity: SandboxOwner['identity'];
	readonly generationId = 'generation';
	readonly shutdown = new AbortController();
	readonly operations = new OperationRegistry();
	readonly mutations = new MutationQueue();
	readonly failures: SandboxErrorInfo[] = [];

	constructor(backend: SandboxBackend) {
		this.backend = backend;
		this.identity = { providerId: 'fixture', backendId: backend.id };
	}

	get lifetime(): AbortSignal {
		return this.shutdown.signal;
	}

	assertLive(operation: SandboxOperation): void {
		if (!this.#isLive) {
			throw new StaleSandboxHandleError({ operation });
		}

		if (this.failures[0] !== undefined) {
			throw this.failures[0];
		}
	}

	markUnhealthy(failure: SandboxErrorInfo): void {
		this.failures.push(failure);
	}

	invalidate(): void {
		this.#isLive = false;
	}
}
