import { expect } from 'vitest';

import { snapshotBackend } from './backend-snapshot.js';
import type { SandboxBackend, SandboxCloseReport } from './contracts.js';
import { SandboxCleanupError } from './errors.js';
import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';
import type {
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';

export type OpeningCase = 'cancelled' | 'invalid' | 'unconfirmed';

export async function verifyProviderOpeningFailure<Config>(
	options: SandboxProviderTestOptions<Config>,
	mode: 'open' | 'copy',
	selection?: SandboxProviderTestSelection
): Promise<void> {
	const fixture = await options.createFixture(selection);

	try {
		const arm = fixture.armOpenFailure?.bind(fixture);

		if (arm === undefined) {
			throw new Error('Supply an opening-failure hook for this fixture.');
		}

		const provider = fixture.provider ?? options.provider;
		const attempt: FixtureAttempt = {};
		const runtime = await fixtureBroker(
			provider,
			fixture.hostWorkspace,
			fixture.configuration,
			{
				policy: fixture.policy,
				...(options.cleanup !== undefined && { cleanup: options.cleanup })
			},
			attempt
		);

		let close: SandboxCloseReport;

		try {
			await bounded(options, () => arm(mode), 'open');
			await expect(
				runtime.acquire({ timeoutMs: options.timeoutMs ?? 10_000 }, mode)
			).rejects.toBeInstanceOf(Error);
		} finally {
			try {
				close = await runtime.close();
			} finally {
				await bounded(
					options,
					() => fixture.verifyDisposed(attempt.backend, attempt.recovery),
					'dispose'
				);
			}
		}

		expect({ backend: attempt.backend, close }).toStrictEqual({
			backend: undefined,
			close: { confirmed: true, failures: [], recoveries: [] }
		});
	} finally {
		await bounded(options, () => fixture.cleanup());
	}
}

export async function verifyOpeningCase<Config>(
	options: SandboxProviderTestOptions<Config>,
	mode: 'open' | 'copy',
	scenario: OpeningCase,
	selection?: SandboxProviderTestSelection
): Promise<void> {
	const fixture = await options.createFixture(selection);

	try {
		const provider = fixture.provider ?? options.provider;
		const attempt: FixtureAttempt = {};
		const controller = new AbortController();
		const timeoutMs = options.timeoutMs ?? 10_000;

		function intercept(backend: SandboxBackend): SandboxBackend {
			if (scenario === 'cancelled') {
				controller.abort();

				return backend;
			}

			const wrapped = snapshotBackend(backend);

			if (scenario === 'invalid') {
				return {
					...wrapped,
					profile: {
						...wrapped.profile,
						policy: {
							...wrapped.profile.policy,
							network: !wrapped.profile.policy.network
						}
					}
				};
			}

			return {
				...wrapped,
				async dispose(context) {
					await wrapped.dispose(context);

					throw new SandboxCleanupError({
						operation: 'dispose',
						recovery: wrapped.recovery
					});
				}
			};
		}

		const runtime = await fixtureBroker(
			provider,
			fixture.hostWorkspace,
			fixture.configuration,
			{
				policy: fixture.policy,
				...(options.cleanup !== undefined && { cleanup: options.cleanup })
			},
			attempt,
			intercept
		);

		let close: Awaited<ReturnType<typeof runtime.close>>;

		try {
			const acquisition = runtime.acquire(
				{ timeoutMs, signal: controller.signal },
				mode
			);

			switch (scenario) {
				case 'cancelled': {
					await expect(acquisition).rejects.toMatchObject({
						name: 'SandboxCancelledError'
					});
					break;
				}

				case 'invalid': {
					await expect(acquisition).rejects.toMatchObject({
						name: 'InvalidSandboxDeclarationError'
					});
					break;
				}

				case 'unconfirmed': {
					await acquisition;
					break;
				}
			}
		} finally {
			close = await runtime.close();
		}

		const backend = attempt.backend;

		if (backend === undefined) {
			throw new Error(
				'The provider failed before the fixture could inject the opening fault.'
			);
		}

		const recovery = attempt.recovery ?? backend.recovery;

		if (scenario === 'unconfirmed') {
			expect({
				confirmed: close.confirmed,
				errors: close.failures.map((error) => error.name),
				recoveries: close.recoveries
			}).toStrictEqual({
				confirmed: false,
				errors: ['SandboxCleanupError'],
				recoveries: recovery.kind === 'allocation' ? [recovery] : []
			});
		} else {
			expect(close).toStrictEqual({
				confirmed: true,
				failures: [],
				recoveries: []
			});
		}

		await bounded(
			options,
			() => fixture.verifyDisposed(backend, recovery),
			'dispose'
		);
	} finally {
		await bounded(options, () => fixture.cleanup());
	}
}
