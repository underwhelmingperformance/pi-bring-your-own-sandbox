import type { SandboxHost, SandboxProvider } from './contracts.js';
import { isDiscoveryRequest } from './discovery.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError
} from './errors.js';
import { isSandboxError } from './errors.js';
import type {
	ConfiguredProviderV1,
	ProviderServiceV1,
	ServiceAdvertisementV1
} from './protocol.js';
import { PROVIDER_DISCOVERY_CHANNEL } from './protocol.js';
import { checker } from './schemas.js';
import { providerDeclarationSchema } from './service-schemas.js';
import {
	isRecord,
	snapshotCapabilities,
	snapshotPolicies
} from './validation.js';

const isProviderDeclaration = checker(providerDeclarationSchema);

/**
Register synchronously during a Pi extension factory, before consumers
acquire a sandbox. Registration validates the declaration and installs a
discovery responder. Configuration validation and backend allocation occur
later; duplicate IDs are rejected during discovery.

@typeParam Config - Provider-specific configuration returned by validation
and received by opening.
@throws {@link InvalidSandboxDeclarationError} if the declaration is
malformed or uses a reserved ID.
*/
export function registerSandboxProvider<Config>(
	pi: SandboxHost,
	provider: SandboxProvider<Config>
): void {
	if (!isProviderDeclaration(provider)) {
		throw new InvalidSandboxDeclarationError({
			operation: 'discover'
		});
	}

	const { id, label } = provider;
	const validate = provider.validateConfig.bind(provider);
	const open = provider.open.bind(provider);
	const service: ProviderServiceV1 = Object.freeze({
		id,
		label,
		capabilities: snapshotCapabilities(provider.capabilities),
		policies: snapshotPolicies(provider.policies),
		configure(input: unknown) {
			let config: Config;

			try {
				config = validate(input);

				if (isRecord(config) && typeof config.then === 'function') {
					// An invalid async validator can reject after this method has thrown.
					void Promise.allSettled([Promise.resolve(config)]);

					throw new InvalidSandboxConfigError({
						operation: 'configure',
						providerId: id
					});
				}
			} catch (error) {
				throw new InvalidSandboxConfigError(
					{
						operation: 'configure',
						providerId: id,
						...(isSandboxError(error) &&
							error.configurationSource !== undefined && {
								configurationSource: error.configurationSource
							})
					},
					{ cause: error }
				);
			}

			const configured: ConfiguredProviderV1 = {
				open: (request, context) =>
					open({ ...request, configuration: config }, context)
			};

			return Object.freeze(configured);
		}
	});
	const advertisement: ServiceAdvertisementV1 = Object.freeze({
		kind: 'pi-byos.provider',
		discoveryVersion: 1,
		serviceVersions: Object.freeze([1]),
		id,
		service
	});

	pi.events.on(PROVIDER_DISCOVERY_CHANNEL, (request) => {
		if (isDiscoveryRequest(request)) {
			request.reply(advertisement);
		}
	});
}
