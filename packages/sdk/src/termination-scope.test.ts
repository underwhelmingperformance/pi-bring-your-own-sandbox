import { expect, it, vi } from 'vitest';

import { acquireOptions, checkRequirements } from './acquire-options.js';
import { UnsupportedSandboxCapabilityError } from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { MemoryBackend } from './fixtures/memory-backend.js';
import { observe } from './lifecycle.js';
import { profileSchema } from './policy-model.js';
import { checker } from './schemas.js';

const isProfile = checker(profileSchema);

const scopes = ['process-group', 'workload'] as const;

it.each(
	scopes.flatMap((effective, rank) =>
		scopes.map((required, minimum) => ({
			effective,
			required,
			satisfies: rank >= minimum
		}))
	)
)(
	'checks $effective against the required $required termination scope',
	({ effective, required, satisfies }) => {
		const backend = new MemoryBackend('exec');

		Object.assign(backend, {
			capabilities: { ...backend.capabilities, terminationScope: effective }
		});

		const sandbox = createSandbox(new TestBackendOwner(backend));
		const options = acquireOptions({ terminationScope: required });
		const check = () => {
			checkRequirements(sandbox, options);
		};

		expect(options).toStrictEqual({
			signal: undefined,
			timeoutMs: undefined,
			terminationScope: required
		});

		if (satisfies) {
			expect(check).not.toThrow();

			return;
		}

		expect(check).toThrow(UnsupportedSandboxCapabilityError);
	}
);

it.each([undefined, 'none', 'tree', 0])(
	'rejects an absent or invalid termination scope: %s',
	(terminationScope) => {
		const backend = new MemoryBackend('exec');

		expect(isProfile({ ...backend.profile, terminationScope })).toBe(false);
	}
);

it.each(['process-group', 'workload'] as const)(
	'quarantines a %s provider that cannot confirm termination',
	async (terminationScope) => {
		const backend = new MemoryBackend('exec');
		const exec = vi.fn(() =>
			Promise.resolve({
				kind: 'cancelled',
				termination: 'unconfirmed'
			} as const)
		);

		Object.assign(backend, {
			capabilities: { ...backend.capabilities, terminationScope },
			exec
		});

		const owner = new TestBackendOwner(backend);
		const sandbox = createSandbox(owner);
		const result = await observe(
			sandbox.exec({ kind: 'argv', executable: 'probe', args: [] })
		);
		const failure: unknown = expect.objectContaining({
			name: 'UnconfirmedSandboxTerminationError',
			completion: 'unknown'
		});

		expect({ result, failures: owner.failures }).toStrictEqual({
			result: { kind: 'rejected', error: failure },
			failures: [failure]
		});
	}
);
