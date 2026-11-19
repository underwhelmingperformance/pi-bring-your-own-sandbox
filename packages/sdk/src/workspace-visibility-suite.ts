import { randomBytes } from 'node:crypto';

import { expect } from 'vitest';

import type {
	ProcessRequest,
	SandboxBackend,
	SandboxOperationContext
} from './contracts.js';
import type { SandboxProviderTestFixture } from './provider-test-contracts.js';

async function execute(
	backend: SandboxBackend,
	request: ProcessRequest,
	context: SandboxOperationContext,
	onStdout?: (bytes: Buffer) => void
): Promise<Buffer> {
	const chunks: Uint8Array[] = [];
	const outcome = await backend.exec(request, {
		...context,
		onOutput(output) {
			if (output.stream !== 'stdout') {
				return;
			}

			chunks.push(new Uint8Array(output.data));
			onStdout?.(Buffer.concat(chunks));
		}
	});

	const isOptionalStatus =
		backend.capabilities.exitStatus === 'optional' &&
		outcome.kind === 'exited' &&
		outcome.exit.kind === 'unavailable';

	expect(outcome).toStrictEqual({
		kind: 'exited',
		exit: isOptionalStatus ? { kind: 'unavailable' } : { kind: 'code', code: 0 }
	});

	return Buffer.concat(chunks);
}

export async function checkWorkspaceVisibility(
	relationship: 'shared' | 'copied',
	fixture: SandboxProviderTestFixture,
	backend: SandboxBackend,
	context: SandboxOperationContext
): Promise<void> {
	expect(backend.workspace.relationship).toBe(relationship);

	const probe = fixture.visibility;

	if (probe === undefined) {
		throw new Error('Supply a workspace visibility probe for this scenario.');
	}

	const initial = Buffer.from(await probe.readSource());

	expect(await execute(backend, probe.readTarget, context)).toStrictEqual(
		initial
	);

	const replaced = randomBytes(24);

	await probe.replaceSource(replaced);

	const expected = relationship === 'shared' ? replaced : initial;

	expect(await execute(backend, probe.readTarget, context)).toStrictEqual(
		expected
	);

	const reader = backend.files?.read;

	if (reader !== undefined) {
		expect(
			Buffer.from(await reader.readFile(probe.targetPath, context))
		).toStrictEqual(expected);
	}

	if (fixture.policy.workspaceAccess === 'read-only') {
		return;
	}

	const written = randomBytes(24);

	if (relationship === 'shared') {
		if (probe.waitForReplacement === undefined) {
			throw new Error(
				'Supply a process that waits for a host replacement in the shared workspace.'
			);
		}

		const ready = Promise.withResolvers<boolean>();
		const controller = new AbortController();
		const observed = randomBytes(24);
		const running = execute(
			backend,
			probe.waitForReplacement(written),
			{
				...context,
				signal: AbortSignal.any([context.signal, controller.signal])
			},
			(output) => {
				if (output.includes('ready')) {
					ready.resolve(true);
				}
			}
		);

		try {
			expect(
				await Promise.race([ready.promise, running]),
				'The writer must wait for the host replacement.'
			).toBe(true);
			expect(Buffer.from(await probe.readSource())).toStrictEqual(written);
			await probe.replaceSource(observed);
			expect(await running).toStrictEqual(
				Buffer.concat([Buffer.from('ready'), observed])
			);
		} finally {
			controller.abort();
			await Promise.allSettled([running]);
		}
	} else {
		await execute(backend, probe.writeTarget(written), context);
		expect(await execute(backend, probe.readTarget, context)).toStrictEqual(
			written
		);
		expect(Buffer.from(await probe.readSource())).toStrictEqual(replaced);
	}

	const writer = backend.files?.write;

	if (writer === undefined) {
		return;
	}

	const content = randomBytes(32);

	await writer.writeFile(probe.targetPath, content, context);
	expect(await execute(backend, probe.readTarget, context)).toStrictEqual(
		content
	);
	expect(Buffer.from(await probe.readSource())).toStrictEqual(
		relationship === 'shared' ? content : replaced
	);
}
