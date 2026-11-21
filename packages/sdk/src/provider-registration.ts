import type {
	SandboxHost,
	SandboxProvider,
	SandboxProviderConfig,
	SandboxProviderRegistration
} from './contracts.js';
import { isDiscoveryRequest } from './discovery.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError,
	InvalidSandboxRequestError,
	isSandboxError,
	UnsupportedSandboxPolicyError
} from './errors.js';
import type {
	ConfiguredProviderV1,
	ProviderServiceV1,
	ServiceAdvertisementV1
} from './protocol.js';
import { PROVIDER_DISCOVERY_CHANNEL } from './protocol.js';
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
	provider: SandboxProvider<Config>,
	options?: NoInfer<SandboxProviderRegistration<Input>>
): void {
	if (!isProviderDeclaration(provider)) {
		throw new InvalidSandboxDeclarationError({
			operation: 'discover'
		});
	}

	const configure = options?.configure;

	if (configure !== undefined && typeof configure !== 'function') {
		throw new InvalidSandboxRequestError({ operation: 'configure' });
	}

	registerProviderConfig(pi, provider.id, async (context) => {
		const configured: SandboxProviderConfig<unknown> =
			configure === undefined
				? { configuration: {} }
				: await configure(context);
		const relationship = configured.policy?.workspaceRelationship;

		if (
			relationship !== undefined &&
			!provider.policies.workspaceRelationship?.includes(relationship)
		) {
			throw new UnsupportedSandboxPolicyError({
				operation: 'configure',
				configurationSource: 'extension',
				providerId: provider.id
			});
		}

		return configured;
	});

	const { id } = provider;
	const validate = provider.validateConfig.bind(provider);
	const open = provider.open.bind(provider);
	const openSnapshot = provider.openReviewSnapshot?.bind(provider);
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
					...(isSandboxError(error) &&
						error.configurationSource !== undefined && {
							configurationSource: error.configurationSource
						})
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
				...(openSnapshot !== undefined && {
					openReviewSnapshot: (request, context) =>
						openSnapshot({ ...request, configuration: config }, context)
				}),
				open: (request, context) =>
					open({ ...request, configuration: config }, context)
			});
		}
	});
	const advertisement: ServiceAdvertisementV1 = Object.freeze({
		kind: 'pi-byos.provider',
		discoveryVersion: 1,
		serviceVersions: Object.freeze([
			service.policies.workspaceRelationship === undefined &&
			service.outsideSandbox?.policy.workspaceRelationship === undefined
				? 1
				: 2
		]),
		id,
		service
	});

	pi.events.on(PROVIDER_DISCOVERY_CHANNEL, (request) => {
		if (isDiscoveryRequest(request)) {
			request.reply(advertisement);
		}
	});
}
