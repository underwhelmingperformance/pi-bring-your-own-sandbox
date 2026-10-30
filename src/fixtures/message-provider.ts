import assert from 'node:assert/strict';
import { once } from 'node:events';
import { MessageChannel } from 'node:worker_threads';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	ProcessRequest,
	SandboxBackend,
	SandboxPolicy,
	SandboxProvider
} from '../contracts.js';
import { SandboxOperationError, SandboxTransportError } from '../errors.js';
import type { SandboxProviderTestOptions } from '../provider-test-contracts.js';
import { isRecord } from '../validation.js';

interface PendingProcess {
	readonly context: BackendProcessContext;
	readonly resolve: (outcome: BackendProcessOutcome) => void;
	readonly reject: (error: unknown) => void;
}

const encode = (value: string) => new TextEncoder().encode(value);

class MessageBackend implements SandboxBackend {
	readonly #channel = new MessageChannel();
	readonly #pending = new Map<string, PendingProcess>();
	readonly #jobs = new Set<string>();
	readonly #disposed = Promise.withResolvers<undefined>();
	#closing: Promise<void> | undefined;
	#isClosed = false;
	readonly id = 'message-backend';
	readonly workspace = {
		root: '/message/project',
		pathFlavor: 'posix',
		relationship: 'remote',
		description: 'Message-channel test double without OS isolation.'
	} as const;
	readonly capabilities = { operations: ['exec'], shells: ['sh'] } as const;
	readonly policy: SandboxPolicy;
	readonly policyDescription = 'Test double without OS isolation.';
	readonly recovery = { kind: 'none' } as const;

	constructor(policy: SandboxPolicy) {
		this.policy = policy;
		this.#channel.port1.on('message', (message: unknown) => {
			this.#receive(message);
		});
		this.#channel.port2.on('message', (message: unknown) => {
			this.#dispatch(message);
		});
	}

	#dispatch(message: unknown): void {
		assert.ok(isRecord(message));
		if (message.kind === 'dispose') {
			this.#jobs.clear();
			this.#channel.port2.postMessage({ kind: 'disposed' });
			return;
		}
		assert.equal(typeof message.id, 'string');
		if (typeof message.id !== 'string') {
			return;
		}
		const id = message.id;
		const reply = (value: object) => {
			this.#channel.port2.postMessage({ ...value, id });
		};
		if (message.kind === 'cancel') {
			if (this.#jobs.delete(id)) {
				reply({ kind: 'cancelled' });
			}
			return;
		}
		try {
			assert.equal(message.kind, 'exec');
			assert.ok(isRecord(message.request));
			const request = message.request;
			if (request.kind === 'argv' && request.executable === 'wait') {
				this.#jobs.add(id);
				reply({ kind: 'output', stream: 'stdout', data: encode('ready') });
				return;
			}
			if (request.kind === 'argv' && request.executable === 'pwd') {
				assert.deepEqual(request, {
					kind: 'argv',
					executable: 'pwd',
					args: []
				});
				reply({
					kind: 'output',
					stream: 'stdout',
					data: encode('/message/project\n')
				});
				reply({ kind: 'exited', code: 0 });
				return;
			}
			assert.deepEqual(
				request,
				request.kind === 'argv'
					? { kind: 'argv', executable: 'probe', args: ['$HOME', '; exit 99'] }
					: { kind: 'shell', dialect: 'sh', command: 'probe' }
			);
			for (const [stream, data] of [
				['stdout', new Uint8Array([0, 255])],
				['stderr', encode('error')],
				['stdout', new Uint8Array([10])]
			] as const) {
				reply({ kind: 'output', stream, data });
			}
			reply({ kind: 'exited', code: 7 });
		} catch (error) {
			reply({ kind: 'rejected', error });
		}
	}

	#receive(message: unknown): void {
		assert.ok(isRecord(message));
		if (message.kind === 'disposed') {
			this.#disposed.resolve(undefined);
			return;
		}
		assert.equal(typeof message.id, 'string');
		if (typeof message.id !== 'string') {
			return;
		}
		const pending = this.#pending.get(message.id);
		assert.ok(pending);
		switch (message.kind) {
			case 'output': {
				assert.ok(message.stream === 'stdout' || message.stream === 'stderr');
				assert.ok(message.data instanceof Uint8Array);
				pending.context.onOutput({
					stream: message.stream,
					data: message.data
				});
				return;
			}
			case 'exited': {
				assert.equal(typeof message.code, 'number');
				if (typeof message.code === 'number') {
					pending.resolve({
						kind: 'exited',
						exit: { kind: 'code', code: message.code }
					});
				}
				return;
			}
			case 'cancelled': {
				pending.resolve({ kind: 'cancelled', termination: 'confirmed' });
				return;
			}
			default: {
				pending.reject(
					new SandboxOperationError(
						{ operation: 'exec' },
						{ cause: message.error }
					)
				);
			}
		}
	}

	get activeJobs(): number {
		return this.#jobs.size;
	}

	get isClosed(): boolean {
		return this.#isClosed;
	}

	async exec(
		request: ProcessRequest,
		context: BackendProcessContext
	): Promise<BackendProcessOutcome> {
		if (context.signal.aborted) {
			return { kind: 'cancelled', termination: 'confirmed' };
		}
		const completion = Promise.withResolvers<BackendProcessOutcome>();
		this.#pending.set(context.operationId, { ...completion, context });
		const cancel = () => {
			this.#channel.port1.postMessage({
				kind: 'cancel',
				id: context.operationId
			});
		};
		context.signal.addEventListener('abort', cancel, { once: true });
		try {
			this.#channel.port1.postMessage({
				kind: 'exec',
				id: context.operationId,
				request
			});
			return await completion.promise;
		} finally {
			context.signal.removeEventListener('abort', cancel);
			this.#pending.delete(context.operationId);
		}
	}

	close(): Promise<void> {
		this.#closing ??= (async () => {
			const closed = [this.#channel.port1, this.#channel.port2].map(
				async (port) => {
					const event = once(port, 'close');
					port.close();
					await event;
				}
			);
			for (const pending of this.#pending.values()) {
				pending.reject(new SandboxTransportError({ operation: 'exec' }));
			}
			this.#jobs.clear();
			await Promise.all(closed);
			this.#isClosed = true;
		})();
		return this.#closing;
	}

	async dispose(): Promise<void> {
		this.#channel.port1.postMessage({ kind: 'dispose' });
		await this.#disposed.promise;
		await this.close();
	}
}

export function messageScenario(): SandboxProviderTestOptions<undefined> {
	const connections: MessageBackend[] = [];
	const provider: SandboxProvider<undefined> = {
		id: 'fixture.message',
		label: 'Message-channel provider without OS isolation',
		protocolVersion: 1,
		capabilities: { operations: ['exec'], shells: ['sh'] },
		policies: {
			workspaceAccess: ['read-write'],
			filesystemScope: ['provider-default'],
			networkAccess: ['provider-default']
		},
		validateConfig(input) {
			assert.deepEqual(input, {});
		},
		open(request, context) {
			context.reportRecovery({ kind: 'none' });
			const backend = new MessageBackend(request.policy);
			connections.push(backend);
			return Promise.resolve(backend);
		}
	};
	const probe = {
		exit: { kind: 'code', code: 7 },
		stdout: new Uint8Array([0, 255, 10]),
		stderr: encode('error')
	} as const;
	return {
		label: provider.id,
		provider,
		createFixture: () =>
			Promise.resolve({
				configuration: {},
				hostWorkspace: '/host/message-fixture',
				policy: {
					workspaceAccess: 'read-write',
					filesystemScope: 'provider-default',
					networkAccess: 'provider-default'
				},
				processes: [
					{
						...probe,
						request: {
							kind: 'argv',
							executable: 'probe',
							args: ['$HOME', '; exit 99']
						}
					}
				],
				shells: {
					sh: {
						...probe,
						request: { kind: 'shell', dialect: 'sh', command: 'probe' }
					}
				},
				cancellation: {
					request: { kind: 'argv', executable: 'wait', args: [] },
					ready: encode('ready'),
					verifyStopped() {
						assert.deepEqual(
							connections.map((connection) => connection.activeJobs),
							connections.map(() => 0)
						);
						return Promise.resolve();
					}
				},
				verifyDisposed() {
					assert.deepEqual(
						connections.map((connection) => connection.isClosed),
						connections.map(() => true)
					);
					return Promise.resolve();
				},
				cleanup: async () => {
					await Promise.all(
						connections.map((connection) => connection.close())
					);
				}
			})
	};
}
