import type {
	SandboxHost,
	SandboxProvider,
	SandboxProviderRegistration,
	SandboxReadRootPersistence
} from './contracts.js';
import { bindFactory } from './default-broker.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	isSandboxError
} from './errors.js';
import type { ConfiguredProviderV1, ProviderServiceV1 } from './protocol.js';
import { protocolAddress } from './protocol-address.js';
import { onProtocolRequest, PROVIDER_CHANNEL } from './protocol-envelope.js';
import { providerAdvertisement } from './protocol-payloads.js';
import { projectReply } from './protocol-version.js';
import { sharedSettingsSchema } from './request-schemas.js';
import { localRuntimeBindings } from './runtime-participant.js';
import { checker } from './schemas.js';
import { providerDeclarationSchema } from './service-schemas.js';
import { isRecord, snapshotProviderInfo } from './validation.js';

const isProviderDeclaration = checker(providerDeclarationSchema);

/**
Registers a provider whose construction can fail. The fallback declaration
keeps a failed provider discoverable so selection reports its configuration
error without switching to host execution.
*/
export function registerSandboxProviderFactory<Config, Input = Config>(
	pi: SandboxHost,
	extensionSource: string,
	declaration: Pick<SandboxProvider<Config>, 'id' | 'label' | 'profiles'>,
	create: () => SandboxProvider<Config>,
	options?: NoInfer<SandboxProviderRegistration<Input>>
): void {
	bindFactory(pi, extensionSource);

	let provider: SandboxProvider<Config>;

	try {
		provider = create();
	} catch (error) {
		const fail = (): never => {
			throw new InvalidSandboxConfigError(
				{ operation: 'configure', providerId: declaration.id, extensionSource },
				{ cause: error }
			);
		};

		registerSandboxProvider(
			pi,
			extensionSource,
			{
				...declaration,
				open: fail,
				validateConfig: fail,
				...(declaration.profiles.copy.length > 0 && { copy: fail })
			},
			{ configure: fail }
		);

		return;
	}

	registerSandboxProvider<Config, Input>(
		pi,
		extensionSource,
		provider,
		options
	);
}

/**
Register synchronously during a Pi extension factory, before consumers
acquire a sandbox. Registration validates the declaration and installs a
discovery responder. Configuration validation and backend allocation occur
later; duplicate IDs are rejected during discovery.

@typeParam Config - Provider-specific configuration returned by validation
and received by opening.
@typeParam Input - Raw validator input, defaulting to Config. Specify a separate
type when validation transforms its input. Resolver values do not infer this type.
@throws {@link InvalidSandboxDeclarationError} if the declaration is
malformed or uses a reserved ID.
*/
export function registerSandboxProvider<Config, Input = Config>(
	pi: SandboxHost,
	extensionSource: string,
	provider: SandboxProvider<Config>,
	options?: NoInfer<SandboxProviderRegistration<Input>>
): void {
	if (!isProviderDeclaration(provider)) {
		throw new InvalidSandboxDeclarationError({
			operation: 'discover',
			extensionSource,
			detail: { kind: 'declaration', field: 'provider' }
		});
	}

	const configure = options?.configure;

	if (configure !== undefined && typeof configure !== 'function') {
		throw new InvalidSandboxRequestError({
			operation: 'configure',
			extensionSource,
			detail: { kind: 'request', field: 'configure' }
		});
	}

	const persistReadRoot = options?.persistReadRoot;

	if (persistReadRoot !== undefined && typeof persistReadRoot !== 'function') {
		throw new InvalidSandboxRequestError({
			operation: 'configure',
			extensionSource,
			detail: { kind: 'request', field: 'persistReadRoot' }
		});
	}

	bindFactory(pi, extensionSource);

	const { id } = provider;
	const validate = provider.validateConfig.bind(provider);
	const open = provider.open.bind(provider);
	const copy = provider.copy?.bind(provider);
	const validateConfig = (input: unknown): Config => {
		try {
			const config = validate(input);

			if (isRecord(config) && typeof config['then'] === 'function') {
				void Promise.allSettled([Promise.resolve(config)]);

				throw new InvalidSandboxConfigError({
					operation: 'configure',
					providerId: id
				});
			}

			return config;
		} catch (error) {
			throw new InvalidSandboxConfigError(
				{
					operation: 'configure',
					providerId: id,
					extensionSource,
					configurationSource: 'extension',
					detail: {
						kind: 'config',
						field:
							isSandboxError(error) && error.detail?.kind === 'config'
								? error.detail.field
								: 'configuration'
					}
				},
				{ cause: error }
			);
		}
	};

	const info = snapshotProviderInfo(provider);
	const identity = protocolAddress(pi.events);
	const service: ProviderServiceV1 = Object.freeze({
		...info,
		protocol: identity,
		configure(input: unknown): ConfiguredProviderV1 {
			const config = validateConfig(input);

			return Object.freeze<ConfiguredProviderV1>({
				...(copy !== undefined && {
					copy: (request, context) =>
						copy({ ...request, configuration: config }, context)
				}),
				open: (request, context) =>
					open({ ...request, configuration: config }, context)
			});
		}
	});

	localRuntimeBindings(pi).providers.push(
		Object.freeze({
			...service,
			...(persistReadRoot !== undefined && {
				persistReadRoot: (context: SandboxReadRootPersistence) =>
					persistReadRoot(context, sharedSettingsSchema)
			}),
			resolve: (context: import('./contracts.js').SandboxConfigContext) =>
				configure === undefined
					? { configuration: {} }
					: configure(context, sharedSettingsSchema)
		})
	);

	onProtocolRequest(
		pi.events,
		PROVIDER_CHANNEL,
		identity,
		'get-providers',
		(request) =>
			projectReply(
				providerAdvertisement,
				{ type: 'provider', id, service: info },
				identity,
				request
			),
		'advertisement'
	);
}
