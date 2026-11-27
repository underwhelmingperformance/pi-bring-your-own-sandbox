import { expect } from 'vitest';

import type { SandboxSharedSettings } from './contracts.js';
import { defaultPolicy } from './policy-model.js';
import { isWithinLimit } from './profile-negotiation.js';
import type { FixtureAttempt } from './provider-test-broker.js';
import { fixtureBroker } from './provider-test-broker.js';
import type { SandboxProviderTestOptions } from './provider-test-contracts.js';
import { bounded } from './provider-test-harness.js';

export const invalidSharedSettings = [
	{ field: 'policy', settings: { policy: 'invalid' } },
	{ field: 'allowEscalation', settings: { allowEscalation: 'invalid' } },
	{ field: 'userShell', settings: { userShell: 'invalid' } },
	{ field: 'cleanup', settings: { cleanup: { disposalTimeoutMs: 0 } } }
] as const;

export async function verifyFixtureSettings<Config>(
	options: SandboxProviderTestOptions<Config>,
	scenario: 'valid' | 'default' | (typeof invalidSharedSettings)[number]
): Promise<void> {
	const fixture = await options.createFixture();

	try {
		const provider = fixture.provider ?? options.provider;
		const attempt: FixtureAttempt = {};
		const supplied: SandboxSharedSettings = {
			...(scenario === 'valid' && {
				policy: fixture.policy,
				userShell: provider.profiles.open[0]?.shells[0] ?? 'bash',
				allowEscalation: false,
				cleanup: { cancellationGraceMs: 4000, disposalTimeoutMs: 8000 }
			})
		};
		const runtime = await (typeof scenario === 'string'
			? fixtureBroker(
					provider,
					fixture.hostWorkspace,
					fixture.configuration,
					supplied,
					attempt
				)
			: (Reflect.apply(fixtureBroker<Config>, undefined, [
					provider,
					fixture.hostWorkspace,
					fixture.configuration,
					scenario.settings,
					attempt
				]) as ReturnType<typeof fixtureBroker<Config>>));

		try {
			if (typeof scenario !== 'string') {
				const result = await runtime.negotiate({});

				expect(result).toMatchObject({
					ok: false,
					error: { name: 'InvalidSandboxConfigError' }
				});
				expect(attempt).toStrictEqual({});

				return;
			}

			if (
				scenario === 'default' &&
				provider.profiles.open.every(
					({ policy }) => !isWithinLimit(policy, defaultPolicy)
				)
			) {
				expect(await runtime.negotiate({})).toMatchObject({
					ok: false,
					error: {
						name: 'UnsupportedSandboxPolicyError',
						detail: { kind: 'policy', reason: 'profile' }
					}
				});
				expect(attempt).toStrictEqual({});

				return;
			}

			const { selection } = await runtime.status();
			const result = await runtime.negotiate({});

			if (scenario === 'default') {
				expect({
					selection,
					isWithinDefaults:
						result.ok && isWithinLimit(result.profile.policy, defaultPolicy),
					attempt
				}).toStrictEqual({
					selection: {
						providerId: provider.id,
						source: 'extension',
						policy: result.ok ? result.profile.policy : undefined
					},
					isWithinDefaults: true,
					attempt: {}
				});

				return;
			}

			expect({
				selection,
				policy: result.ok ? result.profile.policy : undefined,
				attempt
			}).toStrictEqual({
				selection: {
					providerId: provider.id,
					source: 'extension',
					policy: fixture.policy,
					userShell: supplied.userShell
				},
				policy: fixture.policy,
				attempt: {}
			});
			await expect(runtime.planEscalation({})).rejects.toMatchObject({
				detail: { kind: 'request', field: 'allowEscalation', value: false }
			});

			const sandbox = await runtime.acquire(
				{ timeoutMs: options.timeoutMs ?? 10_000 },
				'open'
			);

			expect(sandbox.cleanupBudgets).toStrictEqual(supplied.cleanup);
		} finally {
			expect(await runtime.close()).toStrictEqual({
				confirmed: true,
				failures: [],
				recoveries: []
			});

			if (attempt.backend !== undefined) {
				await bounded(
					options,
					() => fixture.verifyDisposed(attempt.backend, attempt.recovery),
					'dispose'
				);
			}
		}
	} finally {
		await bounded(options, () => fixture.cleanup());
	}
}
