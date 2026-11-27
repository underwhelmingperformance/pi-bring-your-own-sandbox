import {
	createEventBus,
	SessionManager
} from '@earendil-works/pi-coding-agent';

import { createSandboxClient } from './client.js';
import type {
	AvailableSandboxProvider,
	RecoveryDescriptor,
	SandboxAcquireOptions,
	SandboxBackend,
	SandboxCleanupBudgets,
	SandboxContext,
	SandboxHost,
	SandboxOpenContext,
	SandboxSharedSettings
} from './contracts.js';
import { startSandboxRuntime } from './default-broker.js';
import { initialiseSandboxHost } from './host.js';
import { registerSandboxProvider } from './provider-registration.js';
import { localRuntimeBindings } from './runtime-participant.js';

const fixtureSource = '<inline:provider-conformance>';

function ignoreEvent(): void {
	return;
}

export interface FixtureAttempt {
	cleanupBudgets?: SandboxCleanupBudgets;
	backend?: SandboxBackend;
	recovery?: RecoveryDescriptor;
	followups?: FixtureAttempt[];
}

export async function fixtureBroker<Config>(
	provider: AvailableSandboxProvider<Config>,
	workspace: string,
	config: Config,
	settings: SandboxSharedSettings,
	attempt: FixtureAttempt,
	intercept?: (backend: SandboxBackend) => SandboxBackend
) {
	let isReady = false;

	const pi: SandboxHost = {
		events: createEventBus(),
		on: () => ignoreEvent,
		sendMessage() {
			return;
		},
		appendEntry() {
			return;
		},
		getActiveTools() {
			if (!isReady) {
				throw new Error('The fixture factory has not finished.');
			}

			return [];
		}
	};
	const context: SandboxContext = {
		cwd: workspace,
		sessionManager: SessionManager.inMemory(workspace)
	};

	async function open(
		run: (running: SandboxOpenContext) => Promise<SandboxBackend>,
		running: SandboxOpenContext
	): Promise<SandboxBackend> {
		let observation = attempt;

		if (attempt.backend !== undefined) {
			observation = {};
			(attempt.followups ??= []).push(observation);
		}

		if (running.cleanupBudgets !== undefined) {
			observation.cleanupBudgets = running.cleanupBudgets;
		}

		const backend = await run({
			...running,
			reportRecovery(recovery) {
				running.reportRecovery(recovery);
				observation.recovery = recovery;
			}
		});

		observation.backend = backend;

		return intercept?.(backend) ?? backend;
	}

	initialiseSandboxHost(pi, fixtureSource);
	registerSandboxProvider<Config>(pi, fixtureSource, {
		...provider,
		create() {
			const implementation = provider.create();
			const copy = implementation.copy?.bind(implementation);

			return {
				configure: () => ({ configuration: config, settings }),
				open: (request, running) =>
					open((active) => implementation.open(request, active), running),
				...(copy !== undefined && {
					copy: (request, running) =>
						open((active) => copy(request, active), running)
				})
			};
		}
	});

	const client = createSandboxClient(pi, fixtureSource);

	isReady = true;
	await startSandboxRuntime(pi, context);

	const broker = localRuntimeBindings(pi).owner;

	if (broker === undefined) {
		throw new Error('The test runtime did not elect the provider fixture.');
	}

	return {
		client,
		context,
		status: () => broker.status(context),
		planEscalation: (options: SandboxAcquireOptions) =>
			broker.planEscalation(context, options),
		negotiate: (options: SandboxAcquireOptions) =>
			client.negotiate(context, options),
		async acquire(options: SandboxAcquireOptions, mode: 'open' | 'copy') {
			if (mode === 'open') {
				return client.get(context, options);
			}

			const { sandbox } = await broker.copy(context, { kind: 'host' }, options);

			return sandbox;
		},
		close: () => broker.close()
	};
}
