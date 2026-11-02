import { randomUUID } from 'node:crypto';

import type {
	BackendProcessContext,
	BackendProcessOutcome,
	RecoveryDescriptor,
	SandboxOperationContext
} from 'pi-bring-your-own-sandbox/api';
import {
	isSandboxError,
	SandboxCancelledError,
	SandboxCleanupError,
	SandboxOperationError,
	SandboxTransportError
} from 'pi-bring-your-own-sandbox/api';
import { Compile } from 'typebox/compile';

import type {
	DockerClient,
	DockerCommand,
	DockerCommandResult,
	DockerOperationContext
} from './contracts.js';
import { containerStateSchema } from './schemas.js';

/**
Label shared by a generation's volume and its job containers.
*/
export const ALLOCATION_LABEL = 'io.pi-byos.reference';

function isCancelled(context: SandboxOperationContext): boolean {
	return context.signal.aborted;
}

/**
Uses the broker's cleanup deadline when cancellation has begun. The independent
signal permits termination requests after foreground execution is aborted.
*/
export function cleanupContext(
	context: SandboxOperationContext,
	operationId = `${context.operationId}:cleanup`
): DockerOperationContext {
	const fallback = Date.now() + 5000;
	const deadline = () => context.cleanup.deadline ?? fallback;

	return {
		cleanup: Object.freeze({
			get deadline() {
				return deadline();
			}
		}),
		operationId,
		signal: new AbortController().signal,
		deadlineChanged: context.signal,
		get deadline() {
			return deadline();
		}
	};
}

const stateValidator = Compile(containerStateSchema);

/**
Manages only resources with one generation's unpredictable allocation identity.
*/
export class DockerResources {
	readonly #client: DockerClient;
	#hasUnconfirmedAllocation = false;
	/**
	Volume identity, also used as the generation's allocation label.
	*/
	readonly volume = `pi-byos-${randomUUID()}`;
	/**
	Cleanup instructions published before the first allocation command.
	*/
	readonly recovery: RecoveryDescriptor;

	constructor(client: DockerClient, socketPath: string) {
		this.#client = client;
		this.recovery = {
			kind: 'allocation',
			id: this.volume,
			lease:
				'Owned by this SDK generation. No automatic expiry; manual cleanup after a host crash.',
			instructions: `On the local daemon at ${socketPath}, remove containers with label ${ALLOCATION_LABEL}=${this.volume}, then remove volume ${this.volume}.`
		};
	}

	async #remove(
		name: string,
		context: DockerOperationContext,
		operation: DockerCommand['operation']
	): Promise<void> {
		try {
			await this.checked(['rm', '--force', name], context, operation);
		} catch (error) {
			const remaining = await this.checked(
				[
					'container',
					'ls',
					'--all',
					'--filter',
					`name=^/${name}$`,
					'--format',
					'{{.ID}}'
				],
				context,
				operation
			);

			if (remaining.stdout.byteLength !== 0) {
				throw error;
			}
		}
	}

	async #attach(
		name: string,
		context: BackendProcessContext,
		operation: 'open' | 'exec'
	): Promise<BackendProcessOutcome | undefined> {
		if (isCancelled(context)) {
			return;
		}

		await this.#client.command({
			args: ['start', '--attach', name],
			context,
			operation,
			recovery: this.recovery,
			onOutput: context.onOutput
		});

		if (isCancelled(context)) {
			return;
		}

		const inspected = await this.checked(
			['inspect', '--format', '{{json .State}}', name],
			context,
			operation
		);
		const state: unknown = JSON.parse(
			new TextDecoder().decode(inspected.stdout)
		);

		if (!stateValidator.Check(state)) {
			throw new TypeError('Docker returned invalid container state metadata.');
		}

		if (state.Error.length > 0) {
			throw new SandboxOperationError(
				{ operation, providerId: 'example.docker', recovery: this.recovery },
				{ cause: new Error(state.Error) }
			);
		}

		if (state.Running || state.Status !== 'exited') {
			throw new TypeError('Docker did not confirm foreground completion.');
		}

		return { kind: 'exited', exit: { kind: 'code', code: state.ExitCode } };
	}

	/**
	Executes a management command and rejects a non-zero CLI status.
	*/
	async checked(
		arguments_: readonly string[],
		context: DockerOperationContext,
		operation: DockerCommand['operation']
	): Promise<DockerCommandResult> {
		try {
			const result = await this.#client.command({
				args: arguments_,
				context,
				operation,
				recovery: this.recovery
			});

			if (result.status !== 0) {
				throw new SandboxTransportError(
					{ operation, providerId: 'example.docker', recovery: this.recovery },
					{
						cause: new Error(
							`Docker ${arguments_[0] ?? 'command'} failed with status ${String(result.status)}.`
						)
					}
				);
			}

			return result;
		} catch (error) {
			if (
				arguments_[0] === 'create' ||
				(arguments_[0] === 'volume' && arguments_[1] === 'create')
			) {
				this.#hasUnconfirmedAllocation = true;
			}

			throw error;
		}
	}

	/**
	Creates and attaches one job. Confirmation requires removal through Docker,
	including when the attached CLI rejects. A failed creation has unknown
	completion because the daemon may allocate after losing its client.
	*/
	async job(
		arguments_: readonly string[],
		context: BackendProcessContext,
		operation: 'open' | 'exec'
	): Promise<BackendProcessOutcome> {
		if (isCancelled(context)) {
			throw new SandboxCancelledError({
				operation,
				providerId: 'example.docker',
				reason: 'caller',
				completion: 'not-started',
				recovery: this.recovery
			});
		}

		const name = `${this.volume}-${randomUUID()}`;
		let hasCreated = false;
		let removal: Promise<void> | undefined;

		const remove = () => {
			removal ??= this.#remove(name, cleanupContext(context), operation);
			void Promise.allSettled([removal]);

			return removal;
		};

		const cancel = () => {
			void remove();
		};

		let result: BackendProcessOutcome | undefined;
		let failure: unknown;

		try {
			await this.checked(
				[
					'create',
					'--name',
					name,
					'--label',
					`${ALLOCATION_LABEL}=${this.volume}`,
					...arguments_
				],
				context,
				operation
			);
			hasCreated = true;
			context.signal.addEventListener('abort', cancel, { once: true });

			if (isCancelled(context)) {
				cancel();
			}

			result = await this.#attach(name, context, operation);
		} catch (error) {
			failure = error;
		}

		try {
			await remove();
		} catch (error) {
			if (isCancelled(context)) {
				return { kind: 'cancelled', termination: 'unconfirmed' };
			}

			throw error;
		} finally {
			context.signal.removeEventListener('abort', cancel);
		}

		if (isCancelled(context)) {
			return {
				kind: 'cancelled',
				termination: hasCreated ? 'confirmed' : 'unconfirmed'
			};
		}

		if (failure !== undefined) {
			if (isSandboxError(failure)) {
				throw failure;
			}

			throw new SandboxTransportError(
				{ operation, providerId: 'example.docker', recovery: this.recovery },
				{ cause: failure }
			);
		}

		if (result === undefined) {
			throw new SandboxTransportError({
				operation,
				providerId: 'example.docker',
				recovery: this.recovery
			});
		}

		return result;
	}

	/**
	Removes labelled containers before their volume; a failed daemon call remains an error.
	*/
	async dispose(context: SandboxOperationContext): Promise<void> {
		const containers = await this.checked(
			[
				'container',
				'ls',
				'--all',
				'--filter',
				`label=${ALLOCATION_LABEL}=${this.volume}`,
				'--format',
				'{{.ID}}'
			],
			context,
			'dispose'
		);
		const ids = new TextDecoder()
			.decode(containers.stdout)
			.trim()
			.split('\n')
			.filter(Boolean);

		if (ids.length > 0) {
			await this.checked(['rm', '--force', ...ids], context, 'dispose');
		}

		const volumes = await this.checked(
			[
				'volume',
				'ls',
				'--filter',
				`label=${ALLOCATION_LABEL}=${this.volume}`,
				'--format',
				'{{.Name}}'
			],
			context,
			'dispose'
		);
		const names = new TextDecoder()
			.decode(volumes.stdout)
			.trim()
			.split('\n')
			.filter(Boolean);

		if (names.includes(this.volume)) {
			await this.checked(['volume', 'rm', this.volume], context, 'dispose');
		}

		if (this.#hasUnconfirmedAllocation) {
			throw new SandboxCleanupError({
				operation: 'dispose',
				providerId: 'example.docker',
				recovery: this.recovery
			});
		}
	}
}
