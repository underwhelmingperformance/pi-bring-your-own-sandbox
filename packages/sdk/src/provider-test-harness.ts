import { resolveCleanupBudgets } from './cleanup-budgets.js';
import type { SandboxOperation, SandboxOperationContext } from './contracts.js';
import { observe, OperationScope, settleOperation } from './lifecycle.js';
import type { Profile } from './policy-model.js';
import { selectProfile } from './profile-negotiation.js';
import type {
	SandboxProviderTestFixture,
	SandboxProviderTestOptions
} from './provider-test-contracts.js';

export async function bounded<Value>(
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

export function fixtureProfile<Config>(
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
