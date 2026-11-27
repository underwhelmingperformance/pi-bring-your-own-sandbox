import type { Sandbox, SandboxCopy } from './contracts.js';
import { profileSchema, providerInfoSchema } from './policy-model.js';
import type { BrokerService } from './protocol.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { copyOptionsSchema } from './protocol-payloads.js';
import { projectOffer } from './protocol-schema.js';
import {
	checkDemand,
	sharedFeatureLevel,
	unavailableFeature
} from './protocol-version.js';
import { rethrowCopyError } from './sandbox-copy.js';
import { checker } from './schemas.js';

const isProviderInfo = checker(providerInfoSchema);
const isProfile = checker(profileSchema);

export function brokerOffers(
	service: BrokerService,
	local: ProtocolIdentity,
	peer: ProtocolIdentity
): BrokerService {
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
		const profile = projectOffer(profileSchema, sandbox.profile, level);

		if (!isProfile(profile)) {
			throw unavailableFeature('sandbox result', level, peer);
		}

		return Object.freeze<Sandbox>({
			...sandbox,
			profile,
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
		async negotiate(context, options) {
			const result = await service.negotiate(context, options);

			if (!result.ok) {
				return result;
			}

			const profile = projectOffer(profileSchema, result.profile, level);

			if (!isProfile(profile)) {
				throw unavailableFeature('negotiation result', level, peer);
			}

			return Object.freeze({ ok: true, profile });
		},
		async status(context) {
			const status = await service.status(context);

			if (status.profile === undefined) {
				return status;
			}

			const profile = projectOffer(profileSchema, status.profile, level);

			if (!isProfile(profile)) {
				throw unavailableFeature('sandbox status', level, peer);
			}

			return Object.freeze({ ...status, profile });
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
