import { bindSandbox } from './consumer-wire-adapter.js';
import { profileSchema, providerInfoSchema } from './policy-model.js';
import type { BrokerService } from './protocol.js';
import type { ProtocolIdentity } from './protocol-envelope.js';
import { projectOffer } from './protocol-schema.js';
import { sharedFeatureLevel, unavailableFeature } from './protocol-version.js';
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

	return {
		resolveReviewSource: service.resolveReviewSource.bind(service),
		async acquire(context, options) {
			return bindSandbox(await service.acquire(context, options), local, peer);
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
