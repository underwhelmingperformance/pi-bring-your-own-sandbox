import { formatCleanupReport } from './cleanup-report.js';
import { inspectContext } from './context.js';
import type {
	SandboxAcquireOptions,
	SandboxCloseReport,
	SandboxContext,
	SandboxHost
} from './contracts.js';
import type { GenerationDependencies } from './generation.js';
import { SandboxGeneration } from './generation.js';
import type {
	BrokerServiceV1,
	ProviderInfo,
	SandboxStatus
} from './protocol.js';

export class SandboxBroker implements BrokerServiceV1 {
	readonly #dependencies: GenerationDependencies;
	#generation: SandboxGeneration | undefined;
	#isClosing = false;
	readonly id: string;

	constructor(
		id: string,
		pi: SandboxHost,
		dependencies: GenerationDependencies
	) {
		this.id = id;
		this.#dependencies = dependencies;
		pi.on('session_start', async (_event, context) => {
			if (this.#isClosing) {
				return;
			}
			await this.#resolve(context).initialize();
		});
		pi.on('session_shutdown', async (_event, context) => {
			const report = await this.close(context);
			if (report.confirmed) {
				return;
			}
			const content = formatCleanupReport(report);
			if (!context.isIdle()) {
				pi.appendEntry('byos-cleanup', { content });
				context.ui.notify(content, 'warning');
			}
			pi.sendMessage(
				{ customType: 'byos', content, display: true },
				{ triggerTurn: false }
			);
		});
	}
	#resolve(context: SandboxContext): SandboxGeneration {
		inspectContext(context, 'acquire');
		this.#generation ??= new SandboxGeneration(context, this.#dependencies);
		if (this.#isClosing) {
			void this.#generation.close();
		}
		return this.#generation;
	}
	acquire(context: SandboxContext, options?: SandboxAcquireOptions) {
		return this.#resolve(context).acquire(context, options);
	}
	close(context: SandboxContext): Promise<SandboxCloseReport> {
		this.#isClosing = true;
		return this.#resolve(context).close();
	}
	status(context: SandboxContext): Promise<SandboxStatus> {
		return this.#resolve(context).status();
	}
	providers(context: SandboxContext): Promise<readonly ProviderInfo[]> {
		return this.#resolve(context).providers();
	}
}
