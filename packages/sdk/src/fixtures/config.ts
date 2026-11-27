import { Type } from 'typebox';

import { cleanupSelectionSchema } from '../cleanup-budgets.js';
import type { SandboxHost } from '../contracts.js';
import { InvalidSandboxConfigError } from '../errors.js';
import { accessPolicySchema } from '../policy-model.js';
import { registerSandboxProvider } from '../provider-registration.js';
import { checker, shellSchema } from '../schemas.js';

import { fixtureProtocolAddress } from './protocol-address.js';
import type { FixtureProvider } from './register-provider.js';
import { registerFixtureProvider } from './register-provider.js';

const schema = Type.Object(
	{
		provider: Type.Optional(Type.String()),
		policy: Type.Optional(accessPolicySchema),
		providerConfig: Type.Optional(Type.Unknown()),
		cleanup: Type.Optional(cleanupSelectionSchema),
		userShell: Type.Optional(shellSchema)
	},
	{ additionalProperties: false }
);
const isSettings = checker(schema);

function source(pi: SandboxHost): string {
	return (
		fixtureProtocolAddress(pi.events)?.extensionSource ?? import.meta.filename
	);
}

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

	activate<Config>(
		pi: SandboxHost,
		provider: FixtureProvider<Config>,
		register = registerSandboxProvider,
		extensionSource = source(pi)
	): void {
		registerFixtureProvider<Config, unknown>(
			pi,
			extensionSource,
			provider,
			{
				configure: async () => {
					const value = await this.#read();

					return {
						configuration: value.providerConfig ?? {},
						settings: {
							...(value.policy !== undefined && { policy: value.policy }),
							...(value.cleanup !== undefined && { cleanup: value.cleanup }),
							...(value.userShell !== undefined && {
								userShell: value.userShell
							})
						}
					};
				}
			},
			register
		);
	}
}
