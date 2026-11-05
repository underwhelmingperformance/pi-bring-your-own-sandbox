import { Type } from 'typebox';

import { cleanupSelectionSchema } from '../cleanup-budgets.js';
import type { SandboxHost, SandboxProvider } from '../contracts.js';
import { InvalidSandboxConfigError } from '../errors.js';
import { registerSandboxProvider } from '../provider-registration.js';
import {
	approvalSelectionSchema,
	outsideSelectionSchema
} from '../request-schemas.js';
import {
	configureExecutionApproval,
	configureOutsideExecution
} from '../runtime-settings.js';
import { checker, policySchema, shellSchema } from '../schemas.js';

const schema = Type.Object(
	{
		provider: Type.Optional(Type.String()),
		policy: Type.Optional(policySchema),
		providerConfig: Type.Optional(Type.Unknown()),
		approval: Type.Optional(approvalSelectionSchema),
		outsideSandbox: Type.Optional(outsideSelectionSchema),
		cleanup: Type.Optional(cleanupSelectionSchema),
		userShell: Type.Optional(shellSchema)
	},
	{ additionalProperties: false }
);
const isSettings = checker(schema);
const defaultPolicy = {
	workspaceAccess: 'read-write',
	filesystemScope: 'provider-default',
	networkAccess: 'provider-default'
} as const;

export class FixtureConfig {
	#value: unknown = {};
	readonly #resolve: (() => Promise<unknown>) | undefined;
	#pending: Promise<unknown> | undefined;

	constructor(resolve?: () => Promise<unknown>) {
		this.#resolve = resolve;
	}

	async #read() {
		if (this.#resolve !== undefined) {
			this.#pending ??= this.#resolve();
			this.#value = await this.#pending;
		}

		if (!isSettings(this.#value)) {
			throw new InvalidSandboxConfigError({
				operation: 'configure',
				configurationSource: 'extension'
			});
		}

		return this.#value;
	}

	set(value: unknown): void {
		this.#value = value;
	}

	bind(pi: SandboxHost): void {
		configureExecutionApproval(pi, async () => {
			const value = await this.#read();

			return value.approval ?? { policy: 'user' };
		});
		configureOutsideExecution(pi, async () => {
			const value = await this.#read();

			return value.outsideSandbox ?? { destination: 'normal' };
		});
	}

	activate<Config>(
		pi: SandboxHost,
		provider: SandboxProvider<Config>,
		register = registerSandboxProvider
	): void {
		register<Config, unknown>(pi, provider, {
			configure: async () => {
				const value = await this.#read();

				return {
					configuration: value.providerConfig ?? {},
					policy: value.policy ?? provider.defaultPolicy ?? defaultPolicy,
					...(value.cleanup !== undefined && { cleanup: value.cleanup }),
					...(value.userShell !== undefined && { userShell: value.userShell })
				};
			}
		});
	}
}
