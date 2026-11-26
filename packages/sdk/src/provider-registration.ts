import type {
	SandboxHost,
	SandboxProvider,
	SandboxProviderRegistration
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
import { registerProviderConfig } from './runtime-settings.js';
import { checker } from './schemas.js';
import { providerDeclarationSchema } from './service-schemas.js';
import {
	isRecord,
	snapshotCapabilities,
	snapshotProviderInfo
} from './validation.js';

const isProviderDeclaration = checker(providerDeclarationSchema);

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

	bindFactory(pi, extensionSource);
	registerProviderConfig(pi, provider.id, (context) =>
		configure === undefined
			? { configuration: {} }
			: configure(context, sharedSettingsSchema)
	);

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

	const outside = provider.outsideSandbox;
	const outsideOpen = outside?.open.bind(outside);
	const service: ProviderServiceV1 = Object.freeze({
		...snapshotProviderInfo(provider),
		...(outside !== undefined &&
			outsideOpen !== undefined && {
				outsideSandbox: Object.freeze({
					label: outside.label,
					capabilities: snapshotCapabilities(outside.capabilities),
					policy: Object.freeze({ ...outside.policy }),
					configure(input: unknown): ConfiguredProviderV1 {
						const config = validateConfig(input);

						return Object.freeze<ConfiguredProviderV1>({
							open: (request, context) =>
								outsideOpen({ ...request, configuration: config }, context)
						});
					}
				})
			}),
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
	const identity = protocolAddress(pi.events);

	onProtocolRequest(
		pi.events,
		PROVIDER_CHANNEL,
		identity,
		'get-providers',
		(request) =>
			projectReply(
				providerAdvertisement,
				{ type: 'provider', id, service },
				identity,
				request
			),
		'advertisement'
	);
}
