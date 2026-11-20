import { randomBytes, randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { validateBackend } from './backend-validation.js';
import { resolveCleanupBudgets } from './cleanup-budgets.js';
import type {
	BackendProcessOutcome,
	DirectoryEntry,
	SandboxBackend,
	SandboxCleanupBudgets,
	SandboxOperation,
	SandboxOperationContext
} from './contracts.js';
import {
	isSandboxError,
	SandboxCancelledError,
	SandboxOperationError,
	SandboxPathNotFoundError,
	SandboxPermissionDeniedError
} from './errors.js';
import {
	isDirectoryEntries,
	isFindResult,
	isGrepResult
} from './file-result.js';
import { OperationScope } from './lifecycle.js';
import type {
	SandboxPolicyScenario,
	SandboxProcessProbe,
	SandboxProviderTestFixture,
	SandboxProviderTestOptions
} from './provider-test-contracts.js';
import {
	isTerminationScopeSatisfied,
	settleProcess
} from './termination-scope.js';
import { isProviderInfo, isRecord, isRecovery } from './validation.js';
import { checkWorkspaceVisibility } from './workspace-visibility-suite.js';

function compareEntries(left: DirectoryEntry, right: DirectoryEntry): number {
	return left.name.localeCompare(right.name);
}

type ContractRun = (
	fixture: SandboxProviderTestFixture,
	backend: SandboxBackend,
	context: SandboxOperationContext,
	afterDisposal: (verify: () => Promise<void>) => void
) => Promise<void>;

interface ContractCase {
	readonly label: string;
	readonly run: ContractRun;
}

async function bounded<Value>(
	options: Pick<SandboxProviderTestOptions<unknown>, 'timeoutMs' | 'cleanup'>,
	run: (context: SandboxOperationContext) => Promise<Value>,
	operation: SandboxOperation = 'exec'
): Promise<Value> {
	const cleanup = resolveCleanupBudgets(options.cleanup);
	const timeoutMs =
		operation === 'dispose'
			? cleanup.disposalTimeoutMs
			: (options.timeoutMs ?? 10_000);
	const scope = new OperationScope(
		{ operation },
		new AbortController().signal,
		{ timeoutMs },
		timeoutMs,
		cleanup
	);

	async function expired(): Promise<never> {
		await scope.whenCancelled();

		throw new Error('The provider contract operation exceeded its deadline.');
	}

	try {
		const result = await Promise.race([run(scope.context), expired()]);

		scope.check('unknown');

		return result;
	} finally {
		scope.dispose();
	}
}

function openFixture<Config>(
	options: SandboxProviderTestOptions<Config>,
	fixture: SandboxProviderTestFixture,
	context: SandboxOperationContext,
	confirmCleanup: () => void
): Promise<SandboxBackend> {
	const config = options.provider.validateConfig(fixture.configuration);

	return options.provider.open(
		{
			generationId: randomUUID(),
			sessionId: randomUUID(),
			hostWorkspace: fixture.hostWorkspace,
			policy: fixture.policy,
			configuration: config
		},
		{
			...context,
			confirmCleanup,
			reportRecovery: (recovery) => {
				expect(isRecovery(recovery)).toBe(true);
			}
		}
	);
}

export async function usingProviderFixture<Config>(
	options: SandboxProviderTestOptions<Config>,
	run: ContractRun
): Promise<void> {
	const timeoutMs = options.timeoutMs ?? 10_000;

	expect(Number.isFinite(timeoutMs) && timeoutMs > 0).toBe(true);

	const deadlines = {
		timeoutMs,
		cleanup: resolveCleanupBudgets(options.cleanup)
	};
	const fixture = await options.createFixture();
	let backend: SandboxBackend | undefined;
	let isCleanupConfirmed = false;
	const afterDisposal: (() => Promise<void>)[] = [];
	const failures: unknown[] = [];

	try {
		expect(isProviderInfo(options.provider)).toBe(true);
		expect(options.provider.protocolVersion).toBe(1);

		backend = await bounded(deadlines, (context) =>
			openFixture(options, fixture, context, () => {
				isCleanupConfirmed = true;
			})
		);
		expect(isCleanupConfirmed).toBe(false);
		validateBackend(backend, options.provider, fixture.policy);

		const capabilities = options.capabilities ?? options.provider.capabilities;

		expect(
			isTerminationScopeSatisfied(
				backend.capabilities.terminationScope,
				capabilities.terminationScope
			)
		).toBe(true);

		for (const capability of capabilities.operations) {
			expect(backend.capabilities.operations).toContain(capability);
		}

		for (const shell of capabilities.shells) {
			expect(backend.capabilities.shells).toContain(shell);
		}

		for (const kind of capabilities.processKinds) {
			expect(backend.capabilities.processKinds).toContain(kind);
		}

		if (capabilities.exitStatus === 'guaranteed') {
			expect(backend.capabilities.exitStatus).toBe('guaranteed');
		}

		const opened = backend;

		await bounded(deadlines, (context) =>
			run(fixture, opened, context, (verify) => {
				afterDisposal.push(verify);
			})
		);
	} catch (error) {
		afterDisposal.length = 0;
		failures.push(error);
	}

	try {
		if (isRecord(backend) && typeof backend.dispose === 'function') {
			const closing = backend;

			await bounded(
				deadlines,
				async (context) => {
					await closing.dispose(context);
					await fixture.verifyDisposed();

					for (const verify of afterDisposal) {
						await verify();
					}
				},
				'dispose'
			);
		}
	} catch (error) {
		failures.push(error);
	}

	try {
		await bounded(deadlines, () => fixture.cleanup());
	} catch (error) {
		failures.push(error);
	}

	if (failures.length === 1) {
		throw failures[0];
	}

	if (failures.length > 1) {
		throw new AggregateError(
			failures,
			'Provider contract checks and cleanup failed.'
		);
	}
}

async function checkProcess(
	backend: SandboxBackend,
	probe: SandboxProcessProbe,
	context: SandboxOperationContext
): Promise<void> {
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const outcome = await backend.exec(probe.request, {
		...context,
		onOutput(output) {
			(output.stream === 'stdout' ? stdout : stderr).push(
				new Uint8Array(output.data)
			);
		}
	});

	if (backend.capabilities.exitStatus === 'guaranteed') {
		expect(probe.exit.kind).not.toBe('unavailable');
	}

	expect({
		outcome,
		stdout: new Uint8Array(Buffer.concat(stdout)),
		stderr: new Uint8Array(Buffer.concat(stderr))
	}).toStrictEqual({
		outcome: { kind: 'exited', exit: probe.exit },
		stdout: new Uint8Array(probe.stdout),
		stderr: new Uint8Array(probe.stderr)
	});
}

async function checkPolicyEffects(
	scenario: SandboxPolicyScenario,
	fixture: SandboxProviderTestFixture,
	backend: SandboxBackend,
	context: SandboxOperationContext
) {
	const prepare = fixture.policyEffects?.[scenario];

	if (!prepare) {
		throw new Error('Supply a policy effect probe for ' + scenario + '.');
	}

	switch (scenario) {
		case 'read-only': {
			expect(backend.policy.workspaceAccess).toBe('read-only');
			break;
		}

		case 'denied-network': {
			expect(backend.policy.networkAccess).toBe('denied');
			break;
		}

		case 'protected-path':
		case 'protected-alias': {
			expect(backend.policy.workspaceProtection?.length ?? 0).toBeGreaterThan(
				0
			);
			break;
		}
		// No default
	}

	const probe = await prepare(backend);

	if (backend.capabilities.exitStatus === 'guaranteed') {
		expect(probe.permitted.exit).toStrictEqual({ kind: 'code', code: 0 });
		expect(probe.denied.exit.kind).toBe('code');

		if (probe.denied.exit.kind === 'code') {
			expect(probe.denied.exit.code).toBeGreaterThan(0);
		}
	}

	await checkProcess(backend, probe.permitted, context);

	const before = structuredClone(await probe.observe());

	if (scenario === 'denied-network') {
		expect(before.kind).toBe('listener');

		if (before.kind === 'listener') {
			expect(before.connections).toBeGreaterThan(0);
		}
	} else if (scenario === 'late-special-file') {
		expect(['special', 'listener']).toContain(before.kind);

		if (before.kind === 'listener') {
			expect(before.connections).toBeGreaterThan(0);
		}
	} else {
		expect(['absent', 'file']).toContain(before.kind);
	}

	await checkProcess(backend, probe.denied, context);
	expect(
		structuredClone(await probe.observe()),
		'The denied process changed the protected resource.'
	).toStrictEqual(before);

	if (scenario === 'denied-network') {
		return;
	}

	const isRead = scenario === 'late-special-file';
	const operation = isRead ? 'files.read' : 'files.write';

	if (!backend.capabilities.operations.includes(operation)) {
		return;
	}

	if (!probe.file) {
		throw new Error('Supply the target path for the denied file operation.');
	}

	const { path, error } = probe.file;
	const expected =
		error === 'absent'
			? SandboxPathNotFoundError
			: error === 'unsupported-file' && isRead
				? SandboxOperationError
				: SandboxPermissionDeniedError;
	const files = backend.files;
	const outcome = isRead
		? files?.read?.readFile(path, context)
		: files?.write?.writeFile(path, randomBytes(32), context);

	if (!outcome) {
		throw new Error('The declared file operation is missing.');
	}

	await expect(outcome).rejects.toMatchObject({ name: expected.errorName });
	expect(
		structuredClone(await probe.observe()),
		'The denied file operation changed the protected resource.'
	).toStrictEqual(before);
}

async function cancelReadyJob(
	fixture: SandboxProviderTestFixture,
	backend: SandboxBackend,
	context: SandboxOperationContext,
	cleanup: SandboxCleanupBudgets
): Promise<void> {
	const probe = fixture.cancellation;

	expect(probe.ready.byteLength).toBeGreaterThan(0);

	const controller = new AbortController();
	const execution = new OperationScope(
		{ operation: 'exec' },
		context.signal,
		{
			signal: controller.signal,
			timeoutMs: Math.max(1, context.remainingMs())
		},
		10_000,
		cleanup
	);
	const stdout: Uint8Array[] = [];
	let outcome: BackendProcessOutcome;
	const expectedTermination =
		backend.capabilities.terminationScope === 'none'
			? 'not-guaranteed'
			: 'confirmed';

	try {
		const result = await settleProcess(
			execution,
			backend.exec(probe.request, {
				...execution.context,
				onOutput(output) {
					if (output.stream !== 'stdout') {
						return;
					}

					stdout.push(new Uint8Array(output.data));

					if (Buffer.concat(stdout).includes(Buffer.from(probe.ready))) {
						controller.abort();
					}
				}
			}),
			backend.capabilities.terminationScope
		);

		if (result.kind === 'rejected') {
			throw result.error;
		}

		if (result.kind === 'abandoned') {
			throw new Error(
				'The provider did not confirm termination within its cleanup deadline.'
			);
		}

		outcome = result.value;
	} catch (error) {
		if (
			!isSandboxError(error, SandboxCancelledError) ||
			error.completion !== expectedTermination
		) {
			throw error;
		}

		outcome = { kind: 'cancelled', termination: expectedTermination };
	} finally {
		execution.dispose();
	}

	expect({
		hasStarted: controller.signal.aborted,
		outcome
	}).toStrictEqual({
		hasStarted: true,
		outcome: { kind: 'cancelled', termination: expectedTermination }
	});
}

async function checkConcurrentCancellation(
	fixture: SandboxProviderTestFixture,
	backend: SandboxBackend,
	context: SandboxOperationContext,
	cleanup: SandboxCleanupBudgets
): Promise<void> {
	const peer = fixture.concurrentJob;

	if (!peer || peer.ready.length === 0) {
		throw new Error(
			'Supply a concurrent job with a non-empty ready marker and an independent release.'
		);
	}

	const response = randomBytes(32);
	const ready = Promise.withResolvers<boolean>();
	const controller = new AbortController();
	const scope = new OperationScope(
		{ operation: 'exec' },
		context.signal,
		{ signal: controller.signal },
		Math.max(1, context.remainingMs()),
		cleanup
	);
	const stdout: Uint8Array[] = [];
	const stderr: Uint8Array[] = [];
	const running = backend.exec(peer.request, {
		...scope.context,
		onOutput({ stream, data }) {
			(stream === 'stdout' ? stdout : stderr).push(new Uint8Array(data));

			if (
				stream === 'stdout' &&
				Buffer.concat(stdout).includes(Buffer.from(peer.ready))
			) {
				ready.resolve(true);
			}
		}
	});

	try {
		expect(
			await Promise.race([ready.promise, running, scope.whenCancelled()]),
			'The peer must start and wait for release.'
		).toBe(true);
		await cancelReadyJob(fixture, backend, context, cleanup);
		await peer.release(response);

		const outcome = await Promise.race([running, scope.whenCancelled()]);
		const exit =
			backend.capabilities.exitStatus === 'optional' &&
			outcome.kind === 'exited' &&
			outcome.exit.kind === 'unavailable'
				? outcome.exit
				: { kind: 'code', code: 0 };

		expect(
			{ outcome, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) },
			'The same peer must return the response sent after cancellation.'
		).toStrictEqual({
			outcome: { kind: 'exited', exit },
			stdout: Buffer.concat([peer.ready, response]),
			stderr: Buffer.alloc(0)
		});
	} finally {
		controller.abort();

		try {
			await settleProcess(
				scope,
				running,
				backend.capabilities.terminationScope
			);
		} finally {
			scope.dispose();
		}
	}
}

export function providerContractCases<Config>(
	options: SandboxProviderTestOptions<Config>
): readonly ContractCase[] {
	const capabilities = options.capabilities ?? options.provider.capabilities;
	const cleanup = resolveCleanupBudgets(options.cleanup);

	if (
		(options.verifyRecoveryAfterCancellation ||
			options.verifyConcurrentCancellation) &&
		capabilities.terminationScope === 'none'
	) {
		throw new Error('Continued use requires confirmed termination.');
	}

	const cases: ContractCase[] = [
		{
			label: 'metadata and policy',
			run: async (fixture, backend, context) => {
				const hasRestrictions =
					(fixture.policy.workspaceProtection?.length ?? 0) > 0 ||
					fixture.policy.workspaceAccess === 'read-only' ||
					fixture.policy.filesystemScope !== 'provider-default' ||
					fixture.policy.networkAccess === 'denied';

				if (hasRestrictions) {
					expect(
						fixture.verifyPolicy,
						'Supply independent checks for restrictive policies.'
					).toBeTypeOf('function');
				}

				await fixture.verifyPolicy?.(backend, context);
			}
		},

		{
			label:
				capabilities.terminationScope === 'none'
					? 'cancellation without a termination guarantee'
					: options.verifyRecoveryAfterCancellation === true
						? 'confirmed cancellation and continued use'
						: 'confirmed cancellation',
			run: async (fixture, backend, context) => {
				const probe = fixture.cancellation;

				await cancelReadyJob(fixture, backend, context, cleanup);

				if (backend.capabilities.terminationScope === 'none') {
					return;
				}

				expect(
					probe.verifyStopped,
					'Supply an independent termination check for the declared scope.'
				).toBeTypeOf('function');
				await probe.verifyStopped?.();

				if (!options.verifyRecoveryAfterCancellation) {
					return;
				}

				if (!probe.after) {
					throw new Error(
						'Supply a process to run after confirmed cancellation.'
					);
				}

				await checkProcess(backend, probe.after, context);
			}
		},
		{
			label: 'idempotent disposal',
			run: (fixture, backend) =>
				bounded(
					options,
					async (context) => {
						await Promise.all([
							backend.dispose(context),
							backend.dispose(context)
						]);
						await fixture.verifyDisposed();
					},
					'dispose'
				)
		}
	];

	const restrictions = options.policyEffects ?? [];

	for (const scenario of restrictions) {
		cases.push({
			label: 'policy effects (' + scenario + ')',
			run: (fixture, backend, context) =>
				checkPolicyEffects(scenario, fixture, backend, context)
		});
	}

	if (options.verifyConcurrentCancellation) {
		cases.push({
			label: 'cancellation leaves a concurrent job running',
			run: (fixture, backend, context) =>
				checkConcurrentCancellation(fixture, backend, context, cleanup)
		});
	}

	if (options.verifyIndependentAllocations) {
		cases.push({
			label: 'independent disposal of allocations from the same source',
			run: async (fixture, first, context) => {
				const probe = fixture.peerProcess;

				if (probe === undefined) {
					throw new Error(
						'Supply a repeatable process for the second allocation.'
					);
				}

				let isConfirmed = false;
				const second = await openFixture(options, fixture, context, () => {
					isConfirmed = true;
				});

				try {
					expect(isConfirmed).toBe(false);
					validateBackend(second, options.provider, fixture.policy);
					await checkProcess(second, probe, context);
					await bounded(
						options,
						(closing) => first.dispose(closing),
						'dispose'
					);
					await checkProcess(second, probe, context);
				} finally {
					await bounded(
						options,
						(closing) => second.dispose(closing),
						'dispose'
					);
				}
			}
		});
	}

	const relationship = options.workspaceVisibility;

	if (relationship !== undefined) {
		cases.push({
			label: `workspace visibility (${relationship})`,
			run: (fixture, backend, context, afterDisposal) =>
				checkWorkspaceVisibility(
					relationship,
					fixture,
					backend,
					context,
					capabilities,
					cleanup,
					afterDisposal
				)
		});
	}

	if (capabilities.processKinds.includes('argv')) {
		cases.push({
			label: 'argv execution',
			run: async (fixture, backend, context) => {
				const processes = fixture.processes ?? [];

				expect(processes.length).toBeGreaterThan(0);

				for (const probe of processes) {
					expect(probe.request.kind).toBe('argv');
					await checkProcess(backend, probe, context);
				}
			}
		});
	}

	for (const dialect of capabilities.shells) {
		cases.push({
			label: `${dialect} execution`,
			run: async (fixture, backend, context) => {
				const probe = fixture.shells?.[dialect];

				expect(probe, `Supply a ${dialect} execution probe.`).toBeDefined();

				if (probe === undefined) {
					return;
				}

				expect({
					kind: probe.request.kind,
					dialect: probe.request.dialect
				}).toStrictEqual({ kind: 'shell', dialect });
				await checkProcess(backend, probe, context);
			}
		});
	}

	if (capabilities.operations.includes('files.read')) {
		cases.push({
			label: 'file reading',
			run: async (fixture, backend, context) => {
				const probe = fixture.read;
				const reader = backend.files?.read;

				expect(probe, 'Supply a seeded file for reading.').toBeDefined();

				if (probe === undefined || reader === undefined) {
					return;
				}

				await reader.access(probe.path, context);
				expect({
					bytes: await reader.readFile(probe.path, context),
					stat: await reader.stat(probe.path, context)
				}).toStrictEqual({
					bytes: probe.bytes,
					stat: { kind: 'file', size: probe.bytes.byteLength }
				});
				await expect(async () =>
					reader.readFile(probe.missingPath, context)
				).rejects.toSatisfy((error: unknown) =>
					isSandboxError(error, SandboxPathNotFoundError)
				);
			}
		});
	}

	if (capabilities.operations.includes('files.write')) {
		cases.push({
			label: 'file mutation',
			run: async (fixture, backend, context) => {
				const probe = fixture.write;
				const writer = backend.files?.write;

				expect(
					probe,
					'Supply a writable target and independent read callback.'
				).toBeDefined();

				if (probe === undefined || writer === undefined) {
					return;
				}

				if (fixture.policy.workspaceAccess === 'read-only') {
					await expect(async () =>
						writer.writeFile(probe.path, new Uint8Array([42]), context)
					).rejects.toSatisfy((error: unknown) =>
						isSandboxError(error, SandboxPermissionDeniedError)
					);

					return;
				}

				await writer.mkdir(probe.directory, context);
				await writer.mkdir(probe.directory, context);

				for (const bytes of [
					new Uint8Array([0, 255, 13, 10]),
					new Uint8Array([42])
				]) {
					await writer.writeFile(probe.path, bytes, context);
					await writer.access(probe.path, context);
					expect(await probe.read()).toStrictEqual(bytes);
				}
			}
		});
	}

	if (capabilities.operations.includes('files.list')) {
		cases.push({
			label: 'directory listing',
			run: async (fixture, backend, context) => {
				const probe = fixture.list;
				const reader = backend.files?.list;

				expect(probe, 'Supply a seeded directory for listing.').toBeDefined();

				if (probe === undefined || reader === undefined) {
					return;
				}

				const entries = await reader.listDirectory(probe.path, context);

				expect(isDirectoryEntries(entries, backend.workspace.pathFlavor)).toBe(
					true
				);
				expect({
					stat: await reader.stat(probe.path, context),
					entries: entries.toSorted(compareEntries)
				}).toStrictEqual({
					stat:
						typeof probe.stat === 'function' ? await probe.stat() : probe.stat,
					entries: probe.entries.toSorted(compareEntries)
				});
			}
		});
	}

	if (capabilities.operations.includes('search.find')) {
		cases.push({
			label: 'glob search',
			run: async (fixture, backend, context) => {
				expect(
					fixture.find?.length,
					'Supply at least one glob query.'
				).toBeGreaterThan(0);

				const probes = fixture.find ?? [];

				for (const probe of probes) {
					const result = await backend.search?.find?.(probe.request, context);

					expect(
						isFindResult(
							result,
							backend.workspace.pathFlavor,
							probe.request.limit ?? 1000
						)
					).toBe(true);
					expect(result).toStrictEqual(probe.result);
				}
			}
		});
	}

	if (capabilities.operations.includes('search.grep')) {
		cases.push({
			label: 'line search',
			run: async (fixture, backend, context) => {
				expect(
					fixture.grep?.length,
					'Supply at least one line query.'
				).toBeGreaterThan(0);

				const probes = fixture.grep ?? [];

				for (const probe of probes) {
					const result = await backend.search?.grep?.(probe.request, context);

					expect(
						isGrepResult(
							result,
							backend.workspace.pathFlavor,
							probe.request.limit ?? 100,
							probe.request.context ?? 0
						)
					).toBe(true);
					expect(result).toStrictEqual(probe.result);
				}
			}
		});
	}

	return cases;
}

/**
Registers Vitest cases for a provider's selected operations and policies. Call
this at test-module scope. Every case opens and disposes a fresh backend and
runs fixture cleanup even if validation, opening or an assertion fails.

The suite checks supplied probes, not universal isolation. Provider authors
must test runtime-specific escape paths and verify target termination and
resource release independently.
@typeParam Config - Validated configuration accepted by the provider.
*/
export function defineSandboxProviderTests<Config>(
	options: SandboxProviderTestOptions<Config>
): void {
	describe(options.label, () => {
		for (const entry of providerContractCases(options)) {
			it(
				entry.label,
				() => usingProviderFixture(options, entry.run),
				(options.timeoutMs ?? 10_000) * 5 +
					resolveCleanupBudgets(options.cleanup).disposalTimeoutMs
			);
		}
	});
}
