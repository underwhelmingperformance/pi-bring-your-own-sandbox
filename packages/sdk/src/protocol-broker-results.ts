import type { Sandbox, SandboxCopy } from './contracts.js';
import type { BrokerServiceV1 } from './protocol.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { copyOptionsSchema } from './protocol-payloads.js';
import { projectOffer } from './protocol-schema.js';
import {
	checkDemand,
	sharedFeatureLevel,
	unavailableFeature
} from './protocol-version.js';
import { rethrowCopyError } from './sandbox-copy.js';
import {
	capabilitiesSchema,
	checker,
	policySchema,
	providerInfoSchema
} from './schemas.js';

const isCapabilities = checker(capabilitiesSchema);
const isProviderInfo = checker(providerInfoSchema);
const isPolicy = checker(policySchema);

export function brokerOffers(
	service: BrokerServiceV1,
	local: ProtocolIdentity,
	peer: ProtocolIdentity
): BrokerServiceV1 {
	const level = sharedFeatureLevel(local, peer);

	if (level === local.featureLevel) {
		return service;
	}

	async function reduceCopy(copy: SandboxCopy): Promise<SandboxCopy> {
		try {
			return Object.freeze({
				sandbox: reduceSandbox(copy.sandbox),
				close: copy.close.bind(copy)
			});
		} catch (error) {
			return rethrowCopyError(error, () => copy.close(), {
				operation: 'dispose',
				providerId: copy.sandbox.providerId,
				backendId: copy.sandbox.backendId
			});
		}
	}

	function reduceSandbox(sandbox: Sandbox): Sandbox {
		const capabilities = projectOffer(
			capabilitiesSchema,
			sandbox.capabilities,
			level
		);
		const policy = projectOffer(policySchema, sandbox.policy, level);

		if (!isCapabilities(capabilities) || !isPolicy(policy)) {
			throw unavailableFeature('sandbox result', level, peer);
		}

		return Object.freeze<Sandbox>({
			...sandbox,
			capabilities,
			policy,
			async copy(options) {
				checkDemand(
					copyOptionsSchema,
					options ?? {},
					local,
					peer,
					'sandbox copy'
				);

				return reduceCopy(await sandbox.copy(options));
			}
		});
	}

	return {
		...service,
		async acquire(context, options) {
			return reduceSandbox(await service.acquire(context, options));
		},
		async copy(context, source, options) {
			return reduceCopy(await service.copy(context, source, options));
		},
		async status(context) {
			const status = await service.status(context);

			if (status.capabilities === undefined) {
				return status;
			}

			const capabilities = projectOffer(
				capabilitiesSchema,
				status.capabilities,
				level
			);

			if (!isCapabilities(capabilities)) {
				throw unavailableFeature('sandbox status', level, peer);
			}

			return Object.freeze({ ...status, capabilities });
		},
		async providers(context) {
			const providers = await service.providers(context);

			return providers.flatMap((provider) => {
				const projected = projectOffer(providerInfoSchema, provider, level);

				return isProviderInfo(projected) ? [projected] : [];
			});
		}
	};
}
