import { describe, it } from 'vitest';

import { resolveCleanupBudgets } from './cleanup-budgets.js';
import { credentialLocations } from './credential-locations.js';
import {
	providerContractCases,
	usingProviderFixture
} from './provider-contract-suite.js';
import {
	piCredentialProbePaths,
	verifyCredentialExclusion,
	verifyCredentialGrant
} from './provider-credential-suite.js';
import {
	verifyOpeningCase,
	verifyProviderOpeningFailure
} from './provider-opening-suite.js';
import {
	invalidSharedSettings,
	verifyFixtureSettings
} from './provider-settings-suite.js';
import type {
	SandboxProviderFixtureOptions,
	SandboxProviderTestOptions,
	SandboxProviderTestSelection
} from './provider-test-contracts.js';
import { bounded, fixtureProfile } from './provider-test-harness.js';
import { verifyWorkspaceCase } from './provider-workspace-suite.js';

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
	options:
		SandboxProviderTestOptions<Config> | SandboxProviderFixtureOptions<Config>
): void {
	const cleanup = resolveCleanupBudgets(options.cleanup);
	const testTimeout =
		(options.timeoutMs ?? 10_000) * 5 +
		3 * cleanup.disposalTimeoutMs +
		2 * cleanup.cancellationGraceMs;

	const isFocused =
		options.workspaceVisibility !== undefined ||
		options.capabilities !== undefined;

	const suiteLabel = isFocused ? options.label + ' (partial)' : options.label;

	describe(suiteLabel, async () => {
		const fixture = await options.createFixture();
		const provider =
			'provider' in options ? options.provider : fixture.provider;
		const canRegister = fixture.register !== undefined;
		const canStageSettings = fixture.stageSettings !== undefined;
		const canInjectOpenFailure = fixture.armOpenFailure !== undefined;

		await bounded(options, () => fixture.cleanup());

		if (provider === undefined) {
			throw new Error(
				'Provide a declaration for conformance profile selection.'
			);
		}

		const registered: SandboxProviderTestOptions<Config> = {
			...options,
			provider
		};
		const variants = isFocused
			? [
					{
						mode:
							options.workspaceVisibility === 'copied'
								? ('copy' as const)
								: ('open' as const),
						label: ''
					}
				]
			: (['open', 'copy'] as const).flatMap((mode) =>
					registered.provider.profiles[mode].map((profile, index) => ({
						mode,
						selection: {
							mode,
							profile
						} satisfies SandboxProviderTestSelection,
						label: `${mode} profile ${String(index + 1)}: `
					}))
				);

		for (const variant of variants) {
			const { mode, label } = variant;
			const selection = 'selection' in variant ? variant.selection : undefined;
			const credentialSelection = selection ?? {
				mode,
				profile: fixtureProfile(registered, fixture)
			};

			for (const entry of providerContractCases(registered, selection)) {
				it(
					label + entry.label,
					() => usingProviderFixture(registered, entry),
					testTimeout +
						(entry.operation === 'independent-disposal'
							? (options.timeoutMs ?? 10_000) + cleanup.disposalTimeoutMs
							: 0)
				);
			}

			for (const [fault, title] of [
				['cancelled', 'disposes an allocation cancelled during open'],
				['invalid', 'cleans up an allocation after open validation fails'],
				['unconfirmed', 'reports recovery when cleanup cannot be confirmed']
			] as const) {
				it(
					label + title,
					() => verifyOpeningCase(registered, mode, fault, selection),
					testTimeout
				);
			}

			it.skipIf(!canInjectOpenFailure)(
				label +
					(canInjectOpenFailure
						? `releases allocations when provider ${mode} fails before publication`
						: `partial run: supply armOpenFailure to check provider ${mode} failure`),
				() => verifyProviderOpeningFailure(registered, mode, selection),
				testTimeout
			);

			if (credentialSelection.mode === 'open') {
				for (const kind of ['read', 'write'] as const) {
					it(
						label + `checks credential ${kind} grant eligibility`,
						() => verifyCredentialGrant(registered, credentialSelection, kind),
						testTimeout
					);
				}
			}

			if (credentialSelection.profile.policy.hostUserData !== 'denied') {
				if (credentialSelection.profile.shells.length === 0) {
					it.skip(
						label +
							'partial run: an argv-only profile needs its own credential command probes'
					);
				}

				for (const location of [
					...credentialLocations,
					...piCredentialProbePaths
				]) {
					it(
						label + 'excludes the credential location ' + location,
						() =>
							verifyCredentialExclusion(
								registered,
								credentialSelection,
								location
							),
						testTimeout
					);
				}
			}

			if (
				mode !== 'open' ||
				(selection === undefined && options.workspaceVisibility !== 'shared')
			) {
				continue;
			}

			if (process.platform !== 'win32') {
				it(
					label + 'refuses a workspace with a special file',
					() => verifyWorkspaceCase(registered, 'special', selection),
					testTimeout
				);
			}

			for (const kind of ['read', 'write'] as const) {
				it(
					label + `checks a workspace ${kind} grant`,
					() => verifyWorkspaceCase(registered, `${kind}-grant`, selection),
					testTimeout
				);
			}
		}

		if (
			registered.provider.profiles.open.length === 0 ||
			options.workspaceVisibility === 'copied'
		) {
			return;
		}

		if (isFocused && !canRegister) {
			return;
		}

		if (!canStageSettings) {
			it(
				'uses the shipped provider registration and preset settings',
				() => verifyFixtureSettings(registered, 'preset'),
				testTimeout
			);

			return;
		}

		it(
			'uses the shared settings',
			() => verifyFixtureSettings(registered, 'valid'),
			testTimeout
		);
		it(
			'uses the default configured policy',
			() => verifyFixtureSettings(registered, 'default'),
			testTimeout
		);

		for (const invalid of invalidSharedSettings) {
			it(
				'refuses an invalid ' + invalid.field + ' setting before allocation',
				() => verifyFixtureSettings(registered, invalid),
				testTimeout
			);
		}
	});
}
