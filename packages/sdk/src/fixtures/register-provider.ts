import type {
	AvailableSandboxProvider,
	SandboxConfigContext,
	SandboxHost,
	SandboxSharedSettings,
	SharedSettingsSchema
} from '../contracts.js';
import { registerSandboxProvider } from '../provider-registration.js';

type Implementation<Config> = ReturnType<
	AvailableSandboxProvider<Config>['create']
>;

export type FixtureProvider<Config> = Omit<
	AvailableSandboxProvider<Config>,
	'create'
> &
	Pick<Implementation<Config>, 'open' | 'copy'> & {
		readonly validateConfig: (input: unknown) => Config;
	};

export interface FixtureProviderOptions<Input> {
	readonly configure: (
		context: SandboxConfigContext,
		schema: SharedSettingsSchema
	) =>
		| Promise<{ configuration: Input; settings?: SandboxSharedSettings }>
		| { configuration: Input; settings?: SandboxSharedSettings };
	readonly persistReadRoot?: Implementation<unknown>['persistReadRoot'];
}

export function fixtureProvider<Config, Input = Config>(
	provider: FixtureProvider<Config>,
	options?: FixtureProviderOptions<Input>
): AvailableSandboxProvider<Config> {
	const { id, label, profiles } = provider;

	return {
		id,
		label,
		profiles,
		create() {
			const copy = provider.copy?.bind(provider);

			return {
				async configure(context, schema) {
					const resolved = await options?.configure(context, schema);

					return {
						configuration: provider.validateConfig(
							resolved === undefined ? {} : resolved.configuration
						),
						...(resolved?.settings !== undefined && {
							settings: resolved.settings
						})
					};
				},
				open: provider.open.bind(provider),
				...(copy !== undefined && { copy }),
				...(options?.persistReadRoot !== undefined && {
					persistReadRoot: options.persistReadRoot
				})
			};
		}
	};
}

export function registerFixtureProvider<Config, Input = Config>(
	pi: SandboxHost,
	extensionSource: string,
	provider: FixtureProvider<Config>,
	options?: FixtureProviderOptions<Input>,
	register = registerSandboxProvider
): void {
	register(pi, extensionSource, fixtureProvider(provider, options));
}
