import { expect, it, vi } from 'vitest';

import { checkRequirements } from './acquire-options.js';
import {
	SandboxTransportError,
	UnsupportedSandboxCapabilityError
} from './errors.js';
import { createSandbox } from './facade.js';
import { TestBackendOwner } from './fixtures/backend-owner.js';
import { shellBackend } from './fixtures/shell-backend.js';
import { isCapabilities } from './validation.js';

function fixture(exitStatus: 'guaranteed' | 'optional' = 'optional') {
	const { backend } = shellBackend();
	const exec = vi.fn(backend.exec);

	Object.assign(backend, {
		capabilities: {
			operations: ['exec'],
			processKinds: ['shell'],
			shells: ['bash'],
			terminationScope: 'workload',
			exitStatus
		},
		exec
	});

	const owner = new TestBackendOwner(backend);

	return { sandbox: createSandbox(owner), owner, exec };
}

it('rejects unsupported argv before provider invocation', async () => {
	const { sandbox, exec } = fixture();

	await expect(
		sandbox.exec({ kind: 'argv', executable: 'echo', args: [] })
	).rejects.toBeInstanceOf(UnsupportedSandboxCapabilityError);
	expect(exec).not.toHaveBeenCalled();
});

it('preserves completed output with unavailable exit details without quarantining', async () => {
	const { sandbox, owner, exec } = fixture();

	exec.mockImplementation((_request, context) => {
		context.onOutput({ stream: 'stdout', data: new Uint8Array([1, 2]) });

		return Promise.resolve({ kind: 'exited', exit: { kind: 'unavailable' } });
	});

	const result = await sandbox.exec({
		kind: 'shell',
		dialect: 'bash',
		command: 'echo'
	});

	expect({ ...result, durationMs: 0 }).toStrictEqual({
		exit: { kind: 'unavailable' },
		stdout: new Uint8Array([1, 2]),
		stderr: new Uint8Array(),
		omittedBytes: { stdout: 0, stderr: 0 },
		durationMs: 0
	});
	expect(owner.failures).toStrictEqual([]);
	await sandbox.exec({ kind: 'shell', dialect: 'bash', command: 'again' });
});

it('quarantines a provider that violates its guaranteed exit status', async () => {
	const { sandbox, owner, exec } = fixture('guaranteed');

	exec.mockResolvedValue({ kind: 'exited', exit: { kind: 'unavailable' } });
	await expect(
		sandbox.exec({ kind: 'shell', dialect: 'bash', command: 'echo' })
	).rejects.toBeInstanceOf(SandboxTransportError);
	expect(owner.failures).toStrictEqual([expect.any(SandboxTransportError)]);
});

it.each([
	{ processKinds: ['argv'] },
	{ shells: ['sh'] },
	{ exitStatus: 'guaranteed' }
] as const)(
	'checks execution requirements at acquisition: %j',
	(requirements) => {
		const { sandbox } = fixture();

		expect(() => {
			checkRequirements(sandbox, requirements);
		}).toThrow(UnsupportedSandboxCapabilityError);
	}
);

it.each([
	{ processKinds: [], shells: [] },
	{ processKinds: ['argv'], shells: ['sh'] },
	{ processKinds: ['shell'], shells: [] },
	{ processKinds: ['shell', 'shell'], shells: ['sh'] }
])('rejects inconsistent execution metadata: %j', (capabilities) => {
	expect(
		isCapabilities({
			operations: ['exec'],
			terminationScope: 'workload',
			exitStatus: 'guaranteed',
			...capabilities
		})
	).toBe(false);
});
