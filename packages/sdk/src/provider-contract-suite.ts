import { randomBytes, randomUUID } from 'node:crypto';

import { expect } from 'vitest';

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
import { observe, OperationScope, settleOperation } from './lifecycle.js';
import type { AccessProperty, Policy, Profile } from './policy-model.js';
import { accessOrder } from './policy-model.js';
import { selectProfile } from './profile-negotiation.js';
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
import {
	isProviderInfo,
	isRecord,
	isRecovery,
	profileCapabilities
} from './validation.js';
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
	readonly operation?: 'dispose' | 'independent-disposal';
	readonly run: ContractRun;
}

async function bounded<Value>(
	options: Pick<
		SandboxProviderTestOptions<unknown>,
		'timeoutMs' | 'cleanup'
	> & { readonly drainOnTimeout?: boolean },
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

	const running = Promise.try(() => run(scope.context));

	try {
		const result = await Promise.race([
			observe(running),
			scope.whenCancelled()
		]);

		if (result.kind === 'cancelled' || scope.reason !== undefined) {
			const stopped = options.drainOnTimeout
				? await settleOperation(scope, running)
				: result;

			throw new Error(
				'The provider contract operation exceeded its deadline.',
				stopped.kind === 'rejected' ? { cause: stopped.error } : undefined
			);
		}

		if (result.kind === 'rejected') {
			throw result.error;
		}

		return result.value;
	} finally {
		scope.dispose();
	}
}

function fixtureProfile<Config>(
	options: SandboxProviderTestOptions<Config>,
	fixture: SandboxProviderTestFixture
): Profile {
	const mode = options.workspaceVisibility === 'copied' ? 'copy' : 'open';
	const selected = selectProfile({
		profiles: options.provider.profiles[mode],
		limit: fixture.policy,
		mode
	});

	if (!selected.ok) {
		throw new Error('The fixture policy does not select a provider profile.');
	}

	return selected.profile;
}

function openFixture<Config>(
	options: SandboxProviderTestOptions<Config>,
	fixture: SandboxProviderTestFixture,
	context: SandboxOperationContext,
	confirmCleanup: () => void
): Promise<SandboxBackend> {
	const request = {
		generationId: randomUUID(),
		sessionId: randomUUID(),
		hostWorkspace: fixture.hostWorkspace,
		profile: fixtureProfile(options, fixture),
		configuration: options.provider.validateConfig(fixture.configuration)
	};
	const opening = {
		...context,
		confirmCleanup,
		reportRecovery: (recovery: unknown) => {
			expect(isRecovery(recovery)).toBe(true);
		}
	};

	if (options.workspaceVisibility !== 'copied') {
		return options.provider.open(request, opening);
	}

	if (options.provider.copy === undefined) {
		throw new Error('The fixture provider cannot copy the workspace.');
	}

	return options.provider.copy(
		{ ...request, source: { kind: 'host' } },
		opening
	);
}

export async function usingProviderFixture<Config>(
	options: SandboxProviderTestOptions<Config>,
	scenario: ContractRun | ContractCase
): Promise<void> {
	const run = typeof scenario === 'function' ? scenario : scenario.run;
	const operation =
		typeof scenario === 'function' ? undefined : scenario.operation;
	const timeoutMs = options.timeoutMs ?? 10_000;

	expect(Number.isFinite(timeoutMs) && timeoutMs > 0).toBe(true);

	const deadlines = {
		timeoutMs,
		cleanup: resolveCleanupBudgets(options.cleanup)
	};
	const fixture = await options.createFixture();
	const backends: SandboxBackend[] = [];
	const afterDisposal: (() => Promise<void>)[] = [];
	const failures: unknown[] = [];

	try {
		expect(isProviderInfo(options.provider)).toBe(true);

		async function open() {
			let isConfirmed = false;
			const backend = await bounded(deadlines, (context) =>
				openFixture(options, fixture, context, () => {
					isConfirmed = true;
				})
			);

			backends.push(backend);
			expect(isConfirmed).toBe(false);
			validateBackend(
				backend,
				options.provider,
				fixtureProfile(options, fixture),
				options.workspaceVisibility === 'copied' ? 'copy' : 'open'
			);

			return backend;
		}

		const backend = await open();
		const declared =
			options.provider.profiles[
				options.workspaceVisibility === 'copied' ? 'copy' : 'open'
			][0];

		if (declared === undefined) {
			throw new Error('The fixture provider declares no open profile.');
		}

		const capabilities = options.capabilities ?? profileCapabilities(declared);

		expect(
			isTerminationScopeSatisfied(
				backend.profile.terminationScope,
				capabilities.terminationScope
			)
		).toBe(true);

		for (const capability of capabilities.operations) {
			expect(backend.profile.capabilities).toContain(capability);
		}

		for (const shell of capabilities.shells) {
			expect(backend.profile.shells).toContain(shell);
		}

		for (const kind of capabilities.processKinds) {
			expect(backend.profile.processKinds).toContain(kind);
		}

		if (capabilities.exitStatus === 'guaranteed') {
			expect(backend.profile.exitStatus).toBe('guaranteed');
		}

		const check = (target: SandboxBackend) =>
			bounded(
				{ ...deadlines, drainOnTimeout: true },
				(context) =>
					run(fixture, target, context, (verify) => {
						afterDisposal.push(verify);
					}),
				operation === 'dispose' ? 'dispose' : 'exec'
			);

		if (operation === 'independent-disposal') {
			const verify = fixture.verifyAllocationDisposed;

			if (!verify) {
				throw new Error(
					'Supply an independent disposal check for each allocation.'
				);
			}

			const peer = await open();

			await check(peer);
			await bounded(
				deadlines,
				async (closing) => {
					await backend.dispose(closing);
					await verify.call(fixture, backend);
				},
				'dispose'
			);
			backends.shift();
			await check(peer);
		} else {
			await check(backend);
		}
	} catch (error) {
		afterDisposal.length = 0;
		failures.push(error);
	}

	let isDisposed = backends.length > 0;

	for (const backend of backends.toReversed()) {
		if (!isRecord(backend) || typeof backend.dispose !== 'function') {
			isDisposed = false;
			continue;
		}

		try {
			await bounded(
				deadlines,
				(context) => backend.dispose(context),
				'dispose'
			);
		} catch (error) {
			isDisposed = false;
			failures.push(error);
		}
	}

	if (isDisposed) {
		try {
			await bounded(
				deadlines,
				async () => {
					await fixture.verifyDisposed();

					for (const verify of afterDisposal) {
						await verify();
					}
				},
				'dispose'
			);
		} catch (error) {
			failures.push(error);
		}
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

	if (backend.profile.exitStatus === 'guaranteed') {
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
			expect(backend.profile.policy.hostWorkspaceWrites).toBe(false);
			break;
		}

		case 'denied-network': {
			expect(backend.profile.policy.network).toBe(false);
			break;
		}

		case 'protected-path':
		case 'protected-alias': {
			break;
		}
		// No default
	}

	const probe = await prepare(backend);

	if (
		scenario !== 'late-special-file' &&
		probe.file?.error === 'unsupported-file'
	) {
		throw new Error(
			'The unsupported-file error applies only to a read of a late special file.'
		);
	}

	if (probe.permitted.exit.kind !== 'unavailable') {
		expect(probe.permitted.exit).toStrictEqual({ kind: 'code', code: 0 });
	}

	if (probe.denied.exit.kind !== 'unavailable') {
		expect(probe.denied.exit.kind).toBe('code');

		if (probe.denied.exit.kind === 'code') {
			expect(probe.denied.exit.code).toBeGreaterThan(0);
		}
	}

	await checkProcess(backend, probe.permitted, context);

	const before = structuredClone(await probe.observe());

	if (scenario === 'denied-network') {
		expect(before.kind).toBe('listener');
	} else if (scenario === 'late-special-file') {
		expect(['special', 'listener']).toContain(before.kind);
	} else {
		expect(['absent', 'file']).toContain(before.kind);
	}

	if (before.kind === 'listener') {
		expect(
			before.connections,
			'Connect an independent control client to the listener first.'
		).toBeGreaterThan(0);
	} else if (before.kind === 'special') {
		expect(
			before.bytesReceived,
			'Send bytes from an independent control writer to the FIFO first.'
		).toBeGreaterThan(0);
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

	if (!backend.profile.capabilities.includes(operation)) {
		return;
	}

	if (!probe.file) {
		throw new Error('Supply the target path for the denied file operation.');
	}

	const { path, error } = probe.file;

	const expected =
		error === 'absent'
			? SandboxPathNotFoundError
			: error === 'unsupported-file'
				? SandboxOperationError
				: SandboxPermissionDeniedError;
	const files = backend.files;
	const outcome = isRead
		? files?.read?.readFile(path, context)
		: files?.write?.writeFile(path, randomBytes(32), context);

	if (!outcome) {
		throw new Error('The declared file operation is missing.');
	}

	await expect(outcome).rejects.toSatisfy((error: unknown) =>
		isSandboxError(error, expected)
	);
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
		backend.profile.terminationScope === 'none'
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
			backend.profile.terminationScope
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
		scope.check();

		if (!fixture.cancellation.verifyStopped) {
			throw new Error(
				'Supply an independent termination check for the declared scope.'
			);
		}

		await fixture.cancellation.verifyStopped();
		scope.check();

		const released = await settleOperation(
			scope,
			peer.release(response, scope.context)
		);

		scope.check('unknown');

		if (released.kind === 'rejected') {
			throw released.error;
		}

		const outcome = await Promise.race([running, scope.whenCancelled()]);
		const exit =
			backend.profile.exitStatus === 'optional' &&
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
			await settleProcess(scope, running, backend.profile.terminationScope);
		} finally {
			scope.dispose();
		}
	}
}

const restrictionChecks = {
	hostWorkspaceWrites: (policy: Policy) => !policy.hostWorkspaceWrites,
	network: (policy: Policy) => !policy.network,
	hostUserData: (policy: Policy) => policy.hostUserData !== 'read-write',
	hostSystemFiles: (policy: Policy) => policy.hostSystemFiles !== 'read-write'
} satisfies Record<AccessProperty, (policy: Policy) => boolean>;

export function providerContractCases<Config>(
	options: SandboxProviderTestOptions<Config>
): readonly ContractCase[] {
	const declared =
		options.provider.profiles[
			options.workspaceVisibility === 'copied' ? 'copy' : 'open'
		][0];

	if (declared === undefined) {
		throw new Error('The fixture provider declares no open profile.');
	}

	const capabilities = options.capabilities ?? profileCapabilities(declared);
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
				const hasRestrictions = accessOrder.some((property) =>
					restrictionChecks[property](backend.profile.policy)
				);

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

				if (backend.profile.terminationScope === 'none') {
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

				if (probe.after.exit.kind !== 'unavailable') {
					expect(probe.after.exit).toStrictEqual({ kind: 'code', code: 0 });
				}

				await checkProcess(backend, probe.after, context);
			}
		},
		{
			label: 'idempotent disposal',
			operation: 'dispose',
			run: async (fixture, backend, context) => {
				await Promise.all([backend.dispose(context), backend.dispose(context)]);
				await fixture.verifyDisposed();
			}
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
			operation: 'independent-disposal',
			run: async (fixture, peer, context) => {
				const probe = fixture.peerProcess;

				if (probe === undefined) {
					throw new Error(
						'Supply a repeatable process for the second allocation.'
					);
				}

				await checkProcess(peer, probe, context);
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

				if (
					backend.workspace.relationship === 'shared' &&
					!backend.profile.policy.hostWorkspaceWrites
				) {
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
