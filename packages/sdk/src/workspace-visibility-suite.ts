import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { expect } from 'vitest';

import type {
	ProcessRequest,
	SandboxBackend,
	SandboxCleanupBudgets,
	SandboxOperationContext
} from './contracts.js';
import { OperationScope } from './lifecycle.js';
import type { Profile } from './policy-model.js';
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
		backend.profile.exitStatus === 'optional' &&
		outcome.kind === 'exited' &&
		outcome.exit.kind === 'unavailable';

	expect(outcome).toStrictEqual({
		kind: 'exited',
		exit: isOptionalStatus ? { kind: 'unavailable' } : { kind: 'code', code: 0 }
	});

	return Buffer.concat(chunks);
}

function readSample(line: string) {
	const [start, end, contents] = line.split('\t', 3);
	const offsetMs = Number(start);
	const elapsedMs = Number(end);

	if (
		!start ||
		!end ||
		contents === undefined ||
		!Number.isFinite(offsetMs) ||
		!Number.isFinite(elapsedMs) ||
		offsetMs < 0 ||
		elapsedMs < offsetMs
	) {
		throw new Error(
			'The host replacement probe reported an invalid read sample.'
		);
	}

	return { offsetMs, elapsedMs, bytes: Buffer.from(contents, 'base64') };
}

async function checkHostReplacement(
	backend: SandboxBackend,
	probe: NonNullable<SandboxProviderTestFixture['visibility']>,
	context: SandboxOperationContext,
	replaced: Buffer,
	replacedAt: number
): Promise<void> {
	const deadline = replacedAt + 1000;
	const staleRead =
		'A fresh target process returned a stale read after the one-second visibility window.';

	if (probe.pollHostReplacement === undefined) {
		for (;;) {
			const dispatchedAt = performance.now();
			const bytes = await execute(backend, probe.readTarget, context);

			if (bytes.equals(replaced)) {
				return;
			}

			if (dispatchedAt > deadline) {
				expect(bytes, staleRead).toStrictEqual(replaced);
			}

			await delay(50, undefined, { signal: context.signal });
		}
	}

	const encoded = replaced.toString('base64');
	const completeLine = `\t${encoded}\n`;
	const dispatchedAt = performance.now();
	const request = probe.pollHostReplacement(replaced, deadline - dispatchedAt);
	let hostElapsedMs: number | undefined;
	const output = await execute(backend, request, context, (bytes) => {
		if (bytes.toString().endsWith(completeLine)) {
			hostElapsedMs ??= performance.now() - replacedAt;
		}
	});
	const lines = output.toString().split('\n');

	expect(lines.pop()).toBe('');

	const reads = lines.map((line) => readSample(line));

	for (const read of reads) {
		if (dispatchedAt + read.offsetMs > deadline) {
			expect(read.bytes, staleRead).toStrictEqual(replaced);
		}
	}

	const complete = reads.at(-1);

	if (complete === undefined || !complete.bytes.equals(replaced)) {
		throw new Error(
			'The host replacement probe stopped before reporting a complete read.'
		);
	}

	console.info('Host replacement visibility in milliseconds', {
		hostWorkspaceWrites: backend.profile.policy.hostWorkspaceWrites,
		target: complete.elapsedMs,
		host: hostElapsedMs
	});
}

export async function checkWorkspaceVisibility(
	relationship: 'shared' | 'copied',
	fixture: SandboxProviderTestFixture,
	backend: SandboxBackend,
	context: SandboxOperationContext,
	capabilities: Profile['capabilities'],
	cleanup: SandboxCleanupBudgets,
	afterDisposal: (verify: () => Promise<void>) => void
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

	const canWrite =
		relationship === 'shared'
			? backend.profile.policy.hostWorkspaceWrites
			: fixture.write !== undefined;
	const saved = randomBytes(32);
	const save = canWrite ? probe.stageSave?.(saved) : undefined;

	if (save !== undefined) {
		await execute(backend, save.prepare, context);
		expect(
			{
				target: await execute(backend, probe.readTarget, context),
				source: Buffer.from(await probe.readSource())
			},
			'Preparing an editor save must leave the destination unchanged.'
		).toStrictEqual({
			target: initial,
			source: initial
		});
	}

	const replaced = randomBytes(24);

	await probe.replaceSource(replaced);

	const replacedAt = performance.now();

	if (relationship === 'copied') {
		afterDisposal(async () => {
			expect(
				Buffer.from(await probe.readSource()),
				'Disposing a copied workspace must leave the source unchanged.'
			).toStrictEqual(replaced);
		});
	}

	const expected = relationship === 'shared' ? replaced : initial;

	if (relationship === 'shared') {
		await checkHostReplacement(backend, probe, context, replaced, replacedAt);
	} else {
		expect(
			await execute(backend, probe.readTarget, context),
			'A target process must observe the negotiated workspace relationship.'
		).toStrictEqual(initial);
	}

	const reader = capabilities.includes('files.read')
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

	if (!canWrite) {
		return;
	}

	if (!save && relationship === 'shared' && probe.linkSource) {
		throw new Error('Supply an editor save to test a hard-linked destination.');
	}

	if (save !== undefined) {
		const observe =
			relationship === 'shared' ? await probe.linkSource?.() : undefined;
		const original = observe && structuredClone(await observe());

		if (original) {
			expect(Buffer.from(original.content)).toStrictEqual(replaced);
			expect(original.links).toBeGreaterThanOrEqual(2);
		}

		await execute(backend, save.commit, context);

		if (observe && original) {
			expect(
				structuredClone(await observe()),
				'An editor save changed the surviving hard link.'
			).toStrictEqual({
				...original,
				links: original.links - 1
			});
		}

		expect(
			{
				target: await execute(backend, probe.readTarget, context),
				source: Buffer.from(await probe.readSource())
			},
			'A completed editor save must replace the file in the negotiated workspace.'
		).toStrictEqual({
			target: saved,
			source: relationship === 'shared' ? saved : replaced
		});
		await checkReader(saved);
	}

	const written = Buffer.concat([randomBytes(24), Uint8Array.of(0, 255)]);
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
			probe.waitForReplacement(written, observed),
			execution.context,
			(output) => {
				if (output.includes('ready')) {
					ready.resolve(true);
				}
			}
		);

		try {
			expect(
				await Promise.race([ready.promise, running, execution.whenCancelled()]),
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
					backend.profile.terminationScope
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
		await checkReader(written);
		await execute(backend, probe.writeTarget(observed), context);
	}

	const paths =
		backend.workspace.pathFlavor === 'posix' ? path.posix : path.win32;
	const targetPath = probe.targetPath;

	async function checkGrep(bytes: Buffer) {
		if (!capabilities.includes('search.grep')) {
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

	await checkReader(observed);
	await checkGrep(observed);

	const writer = capabilities.includes('files.write')
		? backend.files?.write
		: undefined;

	if (writer === undefined) {
		return;
	}

	const content = Buffer.from(randomBytes(32).toString('hex'));

	await writer.writeFile(probe.targetPath, content, context);
	await checkReader(content);
	await checkGrep(content);

	if (capabilities.includes('search.find') && probe.findTarget !== undefined) {
		const basename = paths.basename(probe.findTarget);
		const directory = paths.dirname(probe.findTarget);

		const find = () =>
			backend.search?.find?.({ path: directory, pattern: basename }, context);

		expect(
			await find(),
			'The find probe must start with an absent file.'
		).toStrictEqual({ paths: [], truncated: false });
		await writer.writeFile(paths.join(directory, basename), content, context);
		expect(
			await find(),
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
