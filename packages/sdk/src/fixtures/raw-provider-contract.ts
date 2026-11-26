import { randomUUID } from 'node:crypto';

import { expect } from 'vitest';

import { validateBackend } from '../backend-validation.js';
import { resolveCleanupBudgets } from '../cleanup-budgets.js';
import type { SandboxBackend, SandboxOperationContext } from '../contracts.js';
import type { ContractCase, ContractRun } from '../provider-contract-suite.js';
import type {
	SandboxProviderTestFixture,
	SandboxProviderTestOptions
} from '../provider-test-contracts.js';
import { bounded, fixtureProfile } from '../provider-test-harness.js';
import { isTerminationScopeSatisfied } from '../termination-scope.js';
import {
	isProviderInfo,
	isRecord,
	isRecovery,
	profileCapabilities
} from '../validation.js';

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

export async function usingRawProviderFixture<Config>(
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
