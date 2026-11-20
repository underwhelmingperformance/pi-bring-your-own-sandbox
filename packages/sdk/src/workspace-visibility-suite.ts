import { randomBytes } from 'node:crypto';
import path from 'node:path';

import { expect } from 'vitest';

import type {
	ProcessRequest,
	SandboxBackend,
	SandboxCapabilities,
	SandboxCleanupBudgets,
	SandboxOperationContext
} from './contracts.js';
import { OperationScope } from './lifecycle.js';
import type { SandboxProviderTestFixture } from './provider-test-contracts.js';
import { settleProcess } from './termination-scope.js';

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
	context: SandboxOperationContext,
	capabilities: SandboxCapabilities,
	cleanup: SandboxCleanupBudgets
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

	expect(
		await execute(backend, probe.readTarget, context),
		'A target process must observe the negotiated workspace relationship.'
	).toStrictEqual(expected);

	const reader = capabilities.operations.includes('files.read')
		? backend.files?.read
		: undefined;

	async function checkReader(bytes: Buffer) {
		if (reader !== undefined && probe !== undefined) {
			expect(
				Buffer.from(await reader.readFile(probe.targetPath, context)),
				'The file reader must observe the same contents as target processes.'
			).toStrictEqual(bytes);
		}
	}

	await checkReader(expected);

	if (fixture.policy.workspaceAccess === 'read-only') {
		return;
	}

	const written = Buffer.from(randomBytes(24).toString('hex'));
	const observed = Buffer.from(randomBytes(24).toString('hex'));

	if (relationship === 'shared') {
		if (probe.waitForReplacement === undefined) {
			throw new Error(
				'Supply a process that waits for a host replacement in the shared workspace.'
			);
		}

		const ready = Promise.withResolvers<boolean>();
		const controller = new AbortController();
		const window = Math.max(1, Math.floor(context.remainingMs() * 0.8));
		const execution = new OperationScope(
			{ operation: 'exec' },
			context.signal,
			{ signal: controller.signal },
			window,
			cleanup
		);

		const running = execute(
			backend,
			probe.waitForReplacement(written),
			execution.context,
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

			const result = await Promise.race([running, execution.whenCancelled()]);

			expect(
				result,
				'The writer must observe the host replacement before its deadline.'
			).toStrictEqual(Buffer.concat([Buffer.from('ready'), observed]));
		} finally {
			controller.abort();

			try {
				await settleProcess(
					execution,
					running,
					backend.capabilities.terminationScope
				);
			} finally {
				execution.dispose();
			}
		}
	} else {
		await execute(backend, probe.writeTarget(written), context);
		expect(await execute(backend, probe.readTarget, context)).toStrictEqual(
			written
		);
		expect(
			Buffer.from(await probe.readSource()),
			'A copied write must leave the source file unchanged.'
		).toStrictEqual(replaced);
	}

	const paths =
		backend.workspace.pathFlavor === 'posix' ? path.posix : path.win32;
	const targetPath = probe.targetPath;

	async function checkGrep(bytes: Buffer) {
		if (!capabilities.operations.includes('search.grep')) {
			return;
		}

		const pattern = bytes.toString('utf8');

		expect(
			await backend.search?.grep?.(
				{ path: targetPath, pattern, literal: true },
				context
			),
			'Grep must search the same file as the target process.'
		).toStrictEqual({
			matches: [
				{
					path: paths.basename(targetPath),
					line: 1,
					text: pattern,
					before: [],
					after: []
				}
			],
			truncated: false
		});
	}

	const current = relationship === 'shared' ? observed : written;

	await checkReader(current);
	await checkGrep(current);

	const writer = capabilities.operations.includes('files.write')
		? backend.files?.write
		: undefined;

	if (writer === undefined) {
		return;
	}

	const content = Buffer.from(randomBytes(32).toString('hex'));

	await writer.writeFile(probe.targetPath, content, context);
	await checkReader(content);
	await checkGrep(content);

	if (capabilities.operations.includes('search.find')) {
		const basename = 'byos-' + randomBytes(12).toString('hex');
		const directory = paths.dirname(targetPath);

		await writer.writeFile(paths.join(directory, basename), content, context);
		expect(
			await backend.search?.find?.(
				{ path: directory, pattern: basename },
				context
			),
			'Find must see a new file created by the file writer.'
		).toStrictEqual({ paths: [basename], truncated: false });
	}

	expect(await execute(backend, probe.readTarget, context)).toStrictEqual(
		content
	);
	expect(Buffer.from(await probe.readSource())).toStrictEqual(
		relationship === 'shared' ? content : replaced
	);
}
