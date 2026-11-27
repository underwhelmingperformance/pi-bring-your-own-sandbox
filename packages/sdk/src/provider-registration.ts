import {
	readRootPersistenceSchema,
	sandboxConfigContextSchema,
	sandboxOpenContextSchema
} from './context-schemas.js';
import type {
	AvailableSandboxProvider,
	SandboxConfigContext,
	SandboxHost,
	SandboxProvider,
	SandboxProviderConfig
} from './contracts.js';
import { bindFactory } from './default-broker.js';
import {
	InvalidSandboxConfigError,
	InvalidSandboxDeclarationError,
	isSandboxError
} from './errors.js';
import type { ConfiguredProviderV1, ProviderInfo } from './protocol.js';
import { protocolAddress } from './protocol-address.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { onProtocolRequest, PROVIDER_CHANNEL } from './protocol-envelope.js';
import { providerAdvertisement } from './protocol-payloads.js';
import { projectReply } from './protocol-version.js';
import {
	providerCopyRequestSchema,
	providerOpenRequestSchema
} from './provider-wire-schemas.js';
import {
	invalidField,
	providerConfigSchema,
	sharedSettingsSchema
} from './request-schemas.js';
import { localRuntimeBindings } from './runtime-participant.js';
import { checker } from './schemas.js';
import {
	providerDeclarationSchema,
	providerImplementationSchema,
	unavailableProviderDeclarationSchema
} from './service-schemas.js';
import { isProviderInfo, snapshotProviderInfo } from './validation.js';

const isConfigContext = checker(sandboxConfigContextSchema);
const isOpenContext = checker(sandboxOpenContextSchema);
const isOpenRequest = checker(providerOpenRequestSchema);
const isCopyRequest = checker(providerCopyRequestSchema);
const isReadRootPersistence = checker(readRootPersistenceSchema);
const isProviderDeclaration = checker(providerDeclarationSchema);
const isImplementation = checker(providerImplementationSchema);
const isProviderConfig = checker(providerConfigSchema);
const isUnavailableDeclaration = checker(unavailableProviderDeclarationSchema);

function advertiseProvider(
	pi: SandboxHost,
	identity: ProtocolIdentity,
	info: ProviderInfo
): void {
	onProtocolRequest(
		pi.events,
		PROVIDER_CHANNEL,
		identity,
		'get-providers',
		(request) =>
			projectReply(
				providerAdvertisement,
				{ type: 'provider', service: info },
				identity,
				request
			),
		'advertisement'
	);
}

function bindConfig<Config>(
	declaration: AvailableSandboxProvider<Config>,
	info: ProviderInfo,
	extensionSource: string
) {
	const create = declaration.create.bind(declaration);
	let pending: Promise<ConfiguredProviderV1> | undefined;

	async function configure(
		context: SandboxConfigContext
	): Promise<ConfiguredProviderV1> {
		// Cache the promise before calling provider code that can re-enter the SDK.
		await Promise.resolve();

		const identity = {
			operation: 'configure' as const,
			providerId: info.id,
			extensionSource
		};

		try {
			if (!isConfigContext(context)) {
				throw new InvalidSandboxConfigError({
					...identity,
					detail: { kind: 'config', field: 'context' }
				});
			}

			const implementation = create();

			if (
				!isImplementation(implementation) ||
				info.profiles.copy.length > 0 !== (implementation.copy !== undefined)
			) {
				throw new InvalidSandboxConfigError({
					...identity,
					detail: { kind: 'config', field: 'provider.create' }
				});
			}

			const open = implementation.open.bind(implementation);
			const copy = implementation.copy?.bind(implementation);
			const persist = implementation.persistReadRoot?.bind(implementation);
			const result: SandboxProviderConfig<Config> =
				await implementation.configure(context, sharedSettingsSchema);

			if (!isProviderConfig(result)) {
				throw new InvalidSandboxConfigError({
					...identity,
					detail: {
						kind: 'config',
						field:
							invalidField(providerConfigSchema, result).join('.') ||
							'configuration'
					}
				});
			}

			const { configuration } = result;
			const settings = structuredClone(result.settings);

			if (settings !== undefined) {
				Object.freeze(settings.policy);
				Object.freeze(settings.readRoots);
				Object.freeze(settings.cleanup);
				Object.freeze(settings);
			}

			return Object.freeze<ConfiguredProviderV1>({
				...(settings !== undefined && { settings }),
				async open(request, running) {
					if (!isOpenRequest(request) || !isOpenContext(running)) {
						throw new InvalidSandboxDeclarationError({
							...identity,
							operation: 'open'
						});
					}

					return open({ ...request, configuration }, running);
				},
				...(copy !== undefined && {
					async copy(request, running) {
						if (!isCopyRequest(request) || !isOpenContext(running)) {
							throw new InvalidSandboxDeclarationError({
								...identity,
								operation: 'open'
							});
						}

						return copy({ ...request, configuration }, running);
					}
				}),
				...(persist !== undefined && {
					async persistReadRoot(approval) {
						if (!isReadRootPersistence(approval)) {
							throw new InvalidSandboxConfigError({
								...identity,
								detail: { kind: 'config', field: 'settings.readRoots' }
							});
						}

						await persist(approval, sharedSettingsSchema);
					}
				})
			});
		} catch (error) {
			throw new InvalidSandboxConfigError(
				{
					...identity,
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
	}

	return (context: SandboxConfigContext) => (pending ??= configure(context));
}

/**
Register a declaration during a Pi extension factory. The broker checks for
duplicate IDs before configuring a provider.
*/
export function registerSandboxProvider<Config>(
	pi: SandboxHost,
	extensionSource: string,
	declaration: SandboxProvider<Config>
): void {
	const isUnavailable = isUnavailableDeclaration(declaration);
	const isAvailable =
		isProviderDeclaration(declaration) && isProviderInfo(declaration);

	if (!isUnavailable && !isAvailable) {
		throw new InvalidSandboxDeclarationError({
			operation: 'discover',
			extensionSource,
			detail: { kind: 'declaration', field: 'provider' }
		});
	}

	bindFactory(pi, extensionSource);

	const identity = protocolAddress(pi.events);
	const info = snapshotProviderInfo(
		isUnavailable
			? { ...declaration, profiles: { open: [], copy: [] } }
			: declaration
	);
	const configure =
		'create' in declaration
			? bindConfig(declaration, info, extensionSource)
			: undefined;

	localRuntimeBindings(pi).providers.push(
		Object.freeze({
			...info,
			protocol: identity,
			...(configure !== undefined && { configure })
		})
	);
	advertiseProvider(pi, identity, info);
}
